package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/infra/dbio"
	"databridge-engine/internal/infra/reporter"
	"databridge-engine/internal/model"
	"databridge-engine/pkg/log"

	"go.uber.org/zap"
)

// 本文件实现 docs/API.md 第 5 节「引擎真实同步模式」（start 快照 mode:"real"）。
// 与 mock_runner.go 并列：同样的 goroutine + context.WithCancel 编排骨架、同一套
// repo / reporter / finish 收尾逻辑，只是将「假数据 + tick」换成真实库读写。

// realStopMessage 真实模式下 stop 的终态描述（区别于 mock 的 "(mock)" 口径）。
const realStopMessage = "收到停止指令，实例已终止"

// 端口缺省值（Node 未下发 port 时按方言默认）
const (
	defaultMySQLPort  = 3306
	defaultOraclePort = 1521
)

// realRunner 一次真实同步的上下文：任务快照 + 回报器 + 待上报日志缓冲 + 读写端。
type realRunner struct {
	svc    *taskService
	task   *model.MockTask
	rep    reporter.Reporter
	logger *log.Logger
	logs   []v1.LogItem

	reader *dbio.Reader
	writer *dbio.Writer
}

// runReal mode=real 的实例主循环：建连 -> 构造 Reader/Writer -> 按 syncMode 分派 -> 收尾回报。
func (s *taskService) runReal(ctx context.Context, handle *runHandle, t *model.MockTask) {
	defer handle.markDone()
	defer s.releaseHandle(t.InstanceID, handle)

	logger := &log.Logger{Logger: s.logger.With(
		zap.String("instanceId", t.InstanceID),
		zap.String("taskId", t.TaskID),
		zap.String("mode", model.ModeReal),
	)}
	rep := s.reports.Build(t.ReportURL)

	source, target := realEndpoint(t.Source, t.SourceTable), realEndpoint(t.Target, t.TargetTable)
	conn, err := s.db.Dial(ctx, source, target)
	if err != nil {
		msg := sanitizeError(err.Error(), t)
		logger.Error("真实同步建连失败", zap.String("err", msg))
		s.finish(ctx, t, rep, model.StatusFailed, msg, nil)
		return
	}
	defer func() {
		if cerr := conn.Close(); cerr != nil {
			logger.Warn("关闭数据库连接失败", zap.String("err", sanitizeError(cerr.Error(), t)))
		}
	}()

	mappings := realMappings(t)
	reader, err := conn.NewReader(ctx, mappings)
	if err != nil {
		msg := sanitizeError(err.Error(), t)
		logger.Error("构造真实读取器失败", zap.String("err", msg))
		s.finish(ctx, t, rep, model.StatusFailed, msg, nil)
		return
	}
	// 管道镜像允许 Node 不下发 fieldMappings：以 Reader 兜底出的「源表全列同名映射」为准
	mappings = reader.Mappings()
	t.FieldMappings = modelMappings(mappings)

	writer, err := conn.NewWriter(ctx, mappings)
	if err != nil {
		msg := sanitizeError(err.Error(), t)
		logger.Error("构造真实写入器失败", zap.String("err", msg))
		s.finish(ctx, t, rep, model.StatusFailed, msg, nil)
		return
	}

	r := &realRunner{svc: s, task: t, rep: rep, logger: logger, reader: reader, writer: writer}
	var status, message string
	switch t.SyncMode {
	case model.SyncModeFull:
		status, message = r.full(ctx)
	case model.SyncModeIncremental:
		status, message = r.incremental(ctx)
	case model.SyncModeCDC:
		status, message = r.cdc(ctx)
	default:
		status, message = model.StatusFailed, fmt.Sprintf("不支持的同步模式: %s", t.SyncMode)
	}
	s.finish(ctx, t, rep, status, message, &r.logs)
}

// ---------- full ----------

// full 全量同步：COUNT 定总量 -> 按主键分页读 -> 分事务批写 -> 每批回报进度 + INFO 日志。
func (r *realRunner) full(ctx context.Context) (string, string) {
	t := r.task
	writeMode := realWriteMode(t)

	total, err := r.reader.Count(ctx)
	if err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	t.TotalRows = total
	if err := r.writer.EnsureWritable(ctx, writeMode); err != nil {
		return model.StatusFailed, r.failMsg(err)
	}

	batches := int64(1)
	if total > 0 {
		batches = int64(math.Ceil(float64(total) / float64(t.BatchSize)))
	}
	r.infof("real sync started: mode=full writeMode=%s batch=%d totalRows=%d source=%s target=%s",
		writeMode, t.BatchSize, total, r.reader.Statement(), r.writer.Statement())
	r.publish(ctx)

	orderBy := t.PrimaryKeySourceFields()
	if len(orderBy) == 0 {
		orderBy = r.reader.OrderByFields()
	}
	pkCols := t.PrimaryKeyTargetFields()

	var offset int64
	for {
		if err := ctx.Err(); err != nil {
			return model.StatusStopped, realStopMessage
		}
		rows, _, err := r.reader.FetchBatch(ctx, dbio.Cursor{Offset: offset, OrderBy: orderBy}, t.BatchSize)
		if err != nil {
			if isCancelled(ctx, err) {
				return model.StatusStopped, realStopMessage
			}
			return model.StatusFailed, r.failMsg(err)
		}
		if len(rows) == 0 {
			break
		}
		written, err := r.writer.WriteBatch(ctx, rows, writeMode, pkCols)
		if err != nil {
			if isCancelled(ctx, err) {
				return model.StatusStopped, realStopMessage
			}
			return model.StatusFailed, r.failMsg(err)
		}
		r.advance(int64(len(rows)), written)
		r.infof("batch %d/%d copied, %d rows", t.BatchesDone, batches, written)
		r.publish(ctx)

		offset += int64(len(rows))
		if len(rows) < t.BatchSize {
			break
		}
		if total > 0 && t.ReadRows >= total {
			break
		}
	}
	if total > 0 && t.ReadRows < total {
		r.warnf("源表行数在同步期间发生变化: 已复制 %d / 起始统计 %d", t.ReadRows, total)
		r.publish(ctx)
	}
	return model.StatusSuccess, ""
}

// ---------- incremental ----------

// incremental 增量同步：从 offsetStart 起按增量列拉批写库，位点推进到批内最大值，
// 完成时以 currentOffset 回报最终位点。
func (r *realRunner) incremental(ctx context.Context) (string, string) {
	t := r.task
	writeMode := realWriteMode(t)

	col, err := r.reader.ResolveColumn(t.IncrementalColumn)
	if err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	kind, _ := r.reader.ColumnKind(col)
	after, err := r.startPosition(kind, t.OffsetStart)
	if err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	if pending, err := r.reader.CountAfter(ctx, col, after); err == nil {
		t.TotalRows = pending
	}
	if err := r.writer.EnsureWritable(ctx, writeMode); err != nil {
		return model.StatusFailed, r.failMsg(err)
	}

	pkCols := t.PrimaryKeyTargetFields()
	if after != nil {
		t.CurrentOffset = formatPosition(col, after)
	}
	r.infof("real sync started: mode=incremental column=%s writeMode=%s batch=%d pendingRows=%d startPos=%s",
		col, writeMode, t.BatchSize, t.TotalRows, orNone(t.CurrentOffset))
	r.publish(ctx)

	for {
		if err := ctx.Err(); err != nil {
			return model.StatusStopped, realStopMessage
		}
		rows, _, err := r.reader.FetchBatch(ctx, dbio.Cursor{Col: col, After: after}, t.BatchSize)
		if err != nil {
			if isCancelled(ctx, err) {
				return model.StatusStopped, realStopMessage
			}
			return model.StatusFailed, r.failMsg(err)
		}
		if len(rows) == 0 {
			break
		}
		written, err := r.writer.WriteBatch(ctx, rows, writeMode, pkCols)
		if err != nil {
			if isCancelled(ctx, err) {
				return model.StatusStopped, realStopMessage
			}
			return model.StatusFailed, r.failMsg(err)
		}
		next, ok := maxValue(rows, col)
		r.advance(int64(len(rows)), written)
		t.CurrentOffset = formatPosition(col, next)
		r.infof("batch %d copied, %d rows, offset=%s", t.BatchesDone, written, t.CurrentOffset)
		r.publish(ctx)

		if !ok || !advanced(next, after) {
			r.warnf("增量位点无法继续推进（批内 %s 列全为 NULL 或值未增长），本批后结束: %s", col, t.CurrentOffset)
			r.publish(ctx)
			break
		}
		after = next
	}
	return model.StatusSuccess, ""
}

// ---------- cdc ----------

// cdc 数据管道（非日志挖掘）：按 cdcPollColumn 每 pollIntervalSec 秒轮询一轮增量，
// 无限运行直至 stop；changeRows=累计落库行数、qps=近一轮均值、lagMs=本轮处理耗时、
// cdcPosition=最新位点字符串（如 UPDATED_DT=2026-09-22T10:00:00Z）。
func (r *realRunner) cdc(ctx context.Context) (string, string) {
	t := r.task
	writeMode := realWriteMode(t)

	col, err := r.reader.ResolveColumn(t.CdcPollColumn)
	if err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	kind, _ := r.reader.ColumnKind(col)
	after, err := r.cdcStart(ctx, kind)
	if err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	if err := r.writer.EnsureWritable(ctx, writeMode); err != nil {
		return model.StatusFailed, r.failMsg(err)
	}
	pkCols := t.PrimaryKeyTargetFields()

	t.CdcPosition = formatPosition(col, after)
	r.infof("real pipeline started: column=%s writeMode=%s batch=%d pollInterval=%s startPos=%s source=%s target=%s",
		col, writeMode, t.BatchSize, t.PollInterval(), t.CdcPosition, r.reader.Statement(), r.writer.Statement())
	r.publish(ctx)

	for {
		roundStart := time.Now()
		var (
			roundRows    int64
			roundWritten int64
		)
		for {
			if err := ctx.Err(); err != nil {
				return model.StatusStopped, realStopMessage
			}
			rows, _, err := r.reader.FetchBatch(ctx, dbio.Cursor{Col: col, After: after}, t.BatchSize)
			if err != nil {
				if isCancelled(ctx, err) {
					return model.StatusStopped, realStopMessage
				}
				return model.StatusFailed, r.failMsg(err)
			}
			if len(rows) == 0 {
				break
			}
			written, err := r.writer.WriteBatch(ctx, rows, writeMode, pkCols)
			if err != nil {
				if isCancelled(ctx, err) {
					return model.StatusStopped, realStopMessage
				}
				return model.StatusFailed, r.failMsg(err)
			}
			next, ok := maxValue(rows, col)
			roundRows += int64(len(rows))
			roundWritten += written
			t.IncrCdc(int64(len(rows)), written)
			t.CdcPosition = formatPosition(col, next)
			if !ok || !advanced(next, after) {
				r.warnf("轮询列 %s 批内值未推进（存在 NULL 或重复值），本轮提前结束", col)
				break
			}
			after = next
		}

		lag := time.Since(roundStart)
		t.LagMs = lag.Milliseconds()
		t.CurrentQps = roundQps(roundWritten, lag)
		t.RateRowsPerSec = rowsPerSec(t.ChangeRows, time.Since(t.StartedAt), t.PollInterval())
		if roundRows > 0 {
			r.infof("captured %d change rows, applied %d, lag=%dms, qps=%d, position=%s",
				roundRows, roundWritten, t.LagMs, t.CurrentQps, t.CdcPosition)
		} else {
			r.debugf("idle round: no change after %s", t.CdcPosition)
		}
		r.publish(ctx)

		if err := sleep(ctx, t.PollInterval()); err != nil {
			return model.StatusStopped, realStopMessage
		}
	}
}

// ---------- 公共辅助 ----------

// publish 快照 + 进度回报 + 日志批量回报（复用 taskService 的 mock/real 同一套收尾逻辑）。
func (r *realRunner) publish(ctx context.Context) {
	r.svc.publish(ctx, r.task, r.rep, &r.logs)
}

// advance 推进读取/写入行数与进度、刷新速率。
func (r *realRunner) advance(read, write int64) {
	t := r.task
	t.Incr(read, write)
	t.RateRowsPerSec = rowsPerSec(t.ReadRows, time.Since(t.StartedAt), time.Millisecond)
}

func (r *realRunner) infof(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.logs = append(r.logs, v1.LogItem{Level: "INFO", Message: msg})
	r.logger.Info(msg)
}

func (r *realRunner) warnf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.logs = append(r.logs, v1.LogItem{Level: "WARN", Message: msg})
	r.logger.Warn(msg)
}

func (r *realRunner) debugf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.logger.Debug(msg)
}

// err 统一把底层错误转成「可回报、可日志、不含口令、<=500 字」的消息。
func (r *realRunner) failMsg(err error) string {
	msg := sanitizeError(err.Error(), r.task)
	r.logger.Error("real sync error", zap.String("err", msg))
	return msg
}

// startPosition 解析 Node 下发的起始位点：接受 "COL=value" 或裸值；空值表示从头开始。
func (r *realRunner) startPosition(kind dbio.ValueKind, raw string) (any, error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return nil, nil
	}
	if i := strings.Index(v, "="); i >= 0 {
		v = strings.TrimSpace(v[i+1:])
	}
	if v == "" {
		return nil, nil
	}
	value, err := dbio.ParsePosition(kind, v)
	if err != nil {
		return nil, fmt.Errorf("起始位点 %q 解析失败（列类型按数据字典判为 %s）: %w", raw, kind, err)
	}
	return value, nil
}

// cdcStart 管道起始位点：offsetStart 优先；未给且轮询列是时间列时取源库服务器时间
// （避免引擎与库时区不一致导致首轮漏捕），其余情况从头开始。
func (r *realRunner) cdcStart(ctx context.Context, kind dbio.ValueKind) (any, error) {
	if strings.TrimSpace(r.task.OffsetStart) != "" {
		return r.startPosition(kind, r.task.OffsetStart)
	}
	if kind != dbio.KindTime {
		r.warnf("轮询列类型为 %s，无法用服务器时间做起始位点，本轮从表头开始", kind)
		return nil, nil
	}
	now, err := r.reader.ServerTime(ctx)
	if err != nil {
		return nil, err
	}
	return now, nil
}

// realEndpoint model.Endpoint -> dbio.Endpoint（补默认端口、去空白）。
// table 缺省时回落到快照里的 sourceTable/targetTable 字段。
func realEndpoint(e model.Endpoint, fallbackTable string) dbio.Endpoint {
	table := strings.TrimSpace(e.Table)
	if table == "" {
		table = strings.TrimSpace(fallbackTable)
	}
	ep := dbio.Endpoint{
		Type:     strings.ToLower(strings.TrimSpace(e.Type)),
		Host:     strings.TrimSpace(e.Host),
		Port:     e.Port,
		Database: strings.TrimSpace(e.Database),
		Username: strings.TrimSpace(e.Username),
		Password: e.Password,
		Table:    table,
	}
	if ep.Port <= 0 {
		if ep.Type == dbio.TypeOracle {
			ep.Port = defaultOraclePort
		} else {
			ep.Port = defaultMySQLPort
		}
	}
	return ep
}

// realMappings 快照映射 -> dbio 映射（targetField 缺省沿用源字段名）。
func realMappings(t *model.MockTask) []dbio.FieldMapping {
	out := make([]dbio.FieldMapping, 0, len(t.FieldMappings))
	for _, m := range t.FieldMappings {
		src := strings.TrimSpace(m.SourceField)
		dst := strings.TrimSpace(m.TargetField)
		if dst == "" {
			dst = src
		}
		out = append(out, dbio.FieldMapping{SourceField: src, TargetField: dst, PrimaryKey: m.PrimaryKey})
	}
	return out
}

// modelMappings dbio 映射 -> 快照映射（Reader 兜底出的同名镜像回写进实例，供 GET /tasks 回显）。
func modelMappings(mappings []dbio.FieldMapping) []model.FieldMapping {
	out := make([]model.FieldMapping, 0, len(mappings))
	for _, m := range mappings {
		out = append(out, model.FieldMapping{SourceField: m.SourceField, TargetField: m.TargetField, PrimaryKey: m.PrimaryKey})
	}
	return out
}

// realWriteMode 真实模式冲突策略：Node 未指定时，管道有主键映射则按 upsert 镜像，否则 insert。
func realWriteMode(t *model.MockTask) string {
	if w := strings.TrimSpace(t.WriteMode); w != "" {
		return strings.ToLower(w)
	}
	if t.IsCdc() && len(t.PrimaryKeyTargetFields()) > 0 {
		return model.WriteModeUpsert
	}
	return model.WriteModeInsert
}

// isCancelled 区分「被 stop 打断」与「真错误」：前者回报 stopped，后者回报 failed。
func isCancelled(ctx context.Context, err error) bool {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	return errors.Is(err, dbio.ErrCancelled)
}

// sleep 可被 stop 打断的等待。
func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		d = time.Duration(model.DefaultPollIntervalSec) * time.Second
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// maxValue 取一批里游标列的最大值（Reader 已按该列升序返回，取末行即可）。
func maxValue(rows []map[string]any, col string) (any, bool) {
	for i := len(rows) - 1; i >= 0; i-- {
		if v, ok := lookupFold(rows[i], col); ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

// lookupFold 大小写无关地取行值。
func lookupFold(row map[string]any, key string) (any, bool) {
	if v, ok := row[key]; ok {
		return v, true
	}
	want := strings.ToUpper(strings.TrimSpace(key))
	for k, v := range row {
		if strings.ToUpper(k) == want {
			return v, true
		}
	}
	return nil, false
}

// advanced 位点是否真的向前推进了（避免同值/回退造成死循环）。
func advanced(next, cur any) bool {
	if next == nil {
		return false
	}
	if cur == nil {
		return true
	}
	if a, b, ok := asTimes(next, cur); ok {
		return a.After(b)
	}
	if a, b, ok := asFloats(next, cur); ok {
		return a > b
	}
	return dbio.FormatPosition(next) > dbio.FormatPosition(cur)
}

func formatPosition(col string, v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%s=%s", col, dbio.FormatPosition(v))
}

func asTimes(a, b any) (time.Time, time.Time, bool) {
	ta, ok1 := a.(time.Time)
	tb, ok2 := b.(time.Time)
	return ta, tb, ok1 && ok2
}

func asFloats(a, b any) (float64, float64, bool) {
	fa, ok1 := toFloat(a)
	fb, ok2 := toFloat(b)
	return fa, fb, ok1 && ok2
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case int64:
		return float64(n), true
	case int:
		return float64(n), true
	case float64:
		return n, true
	case float32:
		return float64(n), true
	default:
		return 0, false
	}
}

// roundQps 近一轮的平均落库速率（不足 1 秒按 1 秒折算，避免整轮 0）。
func roundQps(rows int64, elapsed time.Duration) int64 {
	if rows <= 0 {
		return 0
	}
	secs := elapsed.Seconds()
	if secs < 1 {
		secs = 1
	}
	return int64(float64(rows) / secs)
}

// sanitizeError 抹掉任何可能泄漏口令的片段并按契约截断到 500 字。
func sanitizeError(msg string, t *model.MockTask) string {
	for _, p := range []string{t.Source.Password, t.Target.Password} {
		if len(strings.TrimSpace(p)) >= 3 {
			msg = strings.ReplaceAll(msg, p, "***")
		}
	}
	return dbio.TruncateMessage(msg)
}

func orNone(v string) string {
	if strings.TrimSpace(v) == "" {
		return "-"
	}
	return v
}
