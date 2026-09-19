package service

import (
	"context"
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/infra/reader"
	"databridge-engine/internal/infra/reporter"
	"databridge-engine/internal/infra/writer"
	"databridge-engine/internal/model"

	"go.uber.org/zap"
)

// 本文件是 Mock 同步行为的核心实现，严格对应 docs/API.md 第 2 节「引擎模拟行为（Mock 规格）」。
// 第二阶段换成真实读写时，替换 reader/writer Builder 即可，run 循环的编排骨架可保留或重写。

const stopMessage = "收到停止指令，实例已终止 (mock)"

// mock 失败报文：源库类型相关，便于前端演示错误态
var mockErrorsByType = map[string][]string{
	"oracle": {
		"ORA-01555: snapshot too old (mock)",
		"ORA-03113: end-of-file on communication channel (mock)",
		"ORA-00020: maximum number of processes exceeded (mock)",
	},
	"mysql": {
		"Error 1213 (40001): Deadlock found when trying to get lock (mock)",
		"Error 1040 (HY000): Too many connections (mock)",
	},
	"postgresql": {
		"pq: deadlock detected (mock)",
		"pq: too many clients already (mock)",
	},
}

var mockErrorsGeneric = []string{
	"connection reset by peer (mock)",
	"commit failed: transaction aborted (mock)",
	"read timeout from source database (mock)",
}

// run 单个实例的模拟同步循环：一个 goroutine + context.WithCancel。
func (s *taskService) run(ctx context.Context, handle *runHandle, t *model.MockTask) {
	defer handle.markDone()
	defer s.releaseHandle(t.InstanceID, handle)

	if t.IsCdc() {
		// 数据管道（cdc）走独立循环：无 totalRows、无限运行直至 stop（契约第 2 节第 6 条）
		s.runCdc(ctx, t)
		return
	}

	logger := s.logger.With(zap.String("instanceId", t.InstanceID), zap.String("taskId", t.TaskID))
	rep := s.reports.Build(t.ReportURL)

	rd, err := s.readers.Build(ctx, readerSpecOf(t))
	if err != nil {
		logger.Error("构造 Reader 失败", zap.String("err", err.Error()))
		s.finish(ctx, t, rep, model.StatusFailed, "构造 Reader 失败: "+err.Error(), nil)
		return
	}
	wr, err := s.writers.Build(ctx, writerSpecOf(t))
	if err != nil {
		logger.Error("构造 Writer 失败", zap.String("err", err.Error()))
		s.finish(ctx, t, rep, model.StatusFailed, "构造 Writer 失败: "+err.Error(), nil)
		return
	}
	if total, err := rd.TotalRows(ctx); err == nil && total > 0 {
		t.TotalRows = total
	}

	totalBatches := t.TotalBatches()
	batch := make([]map[string]any, t.BatchSize)
	logs := []v1.LogItem{{
		Level: "INFO",
		Message: fmt.Sprintf("sync started: mode=%s batch=%d total=%d source=%s/%s target=%s/%s",
			t.SyncMode, t.BatchSize, t.TotalRows, t.Source.Type, t.Source.Database, t.Target.Type, t.Target.Database),
	}}
	// 启动即回报一次 running/progress=0，让管理端立刻可见实例
	s.publish(ctx, t, rep, &logs)

	ticker := time.NewTicker(s.opts.Tick)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
			return
		case <-ticker.C:
			// 契约第 4 条：failureRate > 0 时预先决定的失败点
			if t.FailAtBatch > 0 && t.BatchesDone+1 >= t.FailAtBatch {
				s.finish(ctx, t, rep, model.StatusFailed, t.FailMsg, &logs)
				return
			}

			rows, err := rd.ReadBatch(ctx, batch)
			if err != nil {
				if ctx.Err() != nil {
					s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
					return
				}
				s.finish(ctx, t, rep, model.StatusFailed, "读取源库失败: "+err.Error(), &logs)
				return
			}
			if rows <= 0 { // 源表已读完
				s.finish(ctx, t, rep, model.StatusSuccess, "", &logs)
				return
			}

			written, err := wr.WriteBatch(ctx, batch[:rows])
			if err != nil {
				if ctx.Err() != nil {
					s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
					return
				}
				s.finish(ctx, t, rep, model.StatusFailed, "写入目标库失败: "+err.Error(), &logs)
				return
			}

			t.Incr(rows, written)
			t.CurrentOffset = s.nextOffset(t)
			t.RateRowsPerSec = rowsPerSec(t.ReadRows, s.now().Sub(t.StartedAt), s.opts.Tick)
			logs = append(logs, v1.LogItem{
				Level:   "INFO",
				Message: fmt.Sprintf("batch %d/%d committed, %d rows", t.BatchesDone, totalBatches, written),
			})

			// 契约第 3 条：每 tick 上报进度 + 批量日志
			s.publish(ctx, t, rep, &logs)

			if t.ReadRows >= t.TotalRows {
				s.finish(ctx, t, rep, model.StatusSuccess, "", &logs)
				return
			}
		}
	}
}

// ---------- cdc（数据管道）模拟：docs/API.md 第 2 节「引擎模拟行为」第 6 条 ----------

// cdc 模拟参数（全部对应契约第 6 条给出的区间）
const (
	// 每 tick 捕获的变更事件增量：随机 5~80 条，累加进 changeRows
	cdcMinEventsPerTick = 5
	cdcMaxEventsPerTick = 80
	// currentQps 在 10~200 之间随机游走，单 tick 最大步长 ±cdcQpsStep
	cdcMinQps  = 10
	cdcMaxQps  = 200
	cdcQpsStep = 20
	// lagMs 常规波动 300~3000ms
	cdcMinLagMs = 300
	cdcMaxLagMs = 3000
	// 约 2% 的 tick 出现 6000+ 的延迟尖峰，用于触发延迟告警演示
	cdcLagSpikeProb    = 0.02
	cdcLagSpikeMinMs   = 6000
	cdcLagSpikeRangeMs = 3000
	// cdcPosition：SCN= 起始基值随机，其后每 tick 递增 cdcScnStepMin~cdcScnStepMax
	cdcScnBaseMin  = 28000000000
	cdcScnBaseSpan = 1000000000
	cdcScnStepMin  = 500
	cdcScnStepMax  = 20000
	// 每 tick 的失败判定系数：概率 = failureRate × 该系数（failureRate=1 时约 15%/tick，
	// 管道没有总批次，故不能沿用 full/incremental 的「预先决定失败批次」策略）
	cdcFailTickFactor = 0.15
)

// mockCdcErrorsByType cdc 模式的 mock 错误报文（契约样例：LOGMINER session terminated (mock)）
var mockCdcErrorsByType = map[string][]string{
	"oracle": {
		"LOGMINER session terminated (mock)",
		"ORA-01291: missing logfile (mock)",
		"LOGMINER: end of log range reached (mock)",
	},
	"mysql": {
		"binlog dump thread terminated: binary log has been purged (mock)",
	},
	"postgresql": {
		"logical replication slot lost: wal_level is not logical (mock)",
	},
}

var mockCdcErrorsGeneric = []string{"LOGMINER session terminated (mock)"}

// runCdc 数据管道模拟循环：一个 goroutine + context.WithCancel，无限运行直至 stop。
// 每 tick 捕获一批变更事件（changeRows 累加）、刷新 currentQps/lagMs/cdcPosition，
// 并照常 POST /report 与 /logs；progress 恒 0、totalRows 不回报。
func (s *taskService) runCdc(ctx context.Context, t *model.MockTask) {
	logger := s.logger.With(
		zap.String("instanceId", t.InstanceID),
		zap.String("pipelineId", t.PipelineID),
		zap.String("taskId", t.TaskID))
	rep := s.reports.Build(t.ReportURL)

	rd, err := s.readers.Build(ctx, readerSpecOf(t))
	if err != nil {
		logger.Error("构造 Reader 失败", zap.String("err", err.Error()))
		s.finish(ctx, t, rep, model.StatusFailed, "构造 Reader 失败: "+err.Error(), nil)
		return
	}
	wr, err := s.writers.Build(ctx, writerSpecOf(t))
	if err != nil {
		logger.Error("构造 Writer 失败", zap.String("err", err.Error()))
		s.finish(ctx, t, rep, model.StatusFailed, "构造 Writer 失败: "+err.Error(), nil)
		return
	}

	rnd := rand.New(rand.NewSource(time.Now().UnixNano()))
	// 事件缓冲区至少容纳单 tick 的最大增量，保证 5~80 条不会被 batchSize 截断
	batchLen := t.BatchSize
	if batchLen < cdcMaxEventsPerTick {
		batchLen = cdcMaxEventsPerTick
	}
	batch := make([]map[string]any, batchLen)

	// 起始指标：qps 落在 10~200 区间内，SCN 位点取随机基值
	qps := int64(cdcMinQps + rnd.Intn(cdcMaxQps-cdcMinQps+1))
	scn := int64(cdcScnBaseMin + rnd.Int63n(cdcScnBaseSpan))
	t.CurrentQps = qps
	t.LagMs = cdcNextLagMs(rnd)
	t.CdcPosition = fmt.Sprintf("SCN=%d", scn)

	logs := []v1.LogItem{{
		Level: "INFO",
		Message: fmt.Sprintf("pipeline started: mode=cdc objects=[%s] source=%s/%s target=%s/%s position=%s",
			strings.Join(t.SyncObjects, ","), t.Source.Type, t.Source.Database,
			t.Target.Type, t.Target.Database, t.CdcPosition),
	}}
	// 启动即回报一次 running（progress=0、totalRows 不回报），让管理端立刻可见管道
	s.publish(ctx, t, rep, &logs)

	ticker := time.NewTicker(s.opts.Tick)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
			return
		case <-ticker.C:
			// failureRate > 0 时逐 tick 判定是否中断（契约第 6 条）
			if t.FailureRate > 0 && rnd.Float64() < t.FailureRate*cdcFailTickFactor {
				s.finish(ctx, t, rep, model.StatusFailed, pickCdcError(t.Source.Type, rnd), &logs)
				return
			}

			events := int64(cdcMinEventsPerTick + rnd.Intn(cdcMaxEventsPerTick-cdcMinEventsPerTick+1))
			// 捕获：reader 以「无总量」模式返回本 tick 的变更行（真实实现即 LogMiner / 逻辑解码）
			captured, err := rd.ReadBatch(ctx, batch[:events])
			if err != nil {
				if ctx.Err() != nil {
					s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
					return
				}
				s.finish(ctx, t, rep, model.StatusFailed, "捕获源库变更日志失败: "+err.Error(), &logs)
				return
			}
			if captured <= 0 {
				captured = events
			}
			applied, err := wr.WriteBatch(ctx, batch[:captured])
			if err != nil {
				if ctx.Err() != nil {
					s.finish(ctx, t, rep, model.StatusStopped, stopMessage, &logs)
					return
				}
				s.finish(ctx, t, rep, model.StatusFailed, "应用变更到目标库失败: "+err.Error(), &logs)
				return
			}
			if applied < 0 {
				applied = 0
			}

			t.IncrCdc(captured, applied)
			qps = cdcWalkQps(qps, rnd)
			t.CurrentQps = qps
			t.LagMs = cdcNextLagMs(rnd)
			scn += int64(cdcScnStepMin + rnd.Intn(cdcScnStepMax-cdcScnStepMin))
			t.CdcPosition = fmt.Sprintf("SCN=%d", scn)
			t.RateRowsPerSec = rowsPerSec(t.ChangeRows, s.now().Sub(t.StartedAt), s.opts.Tick)

			logs = append(logs, v1.LogItem{
				Level: "INFO",
				Message: fmt.Sprintf("捕获 %d 条变更 (mock), lag=%dms, qps=%d, applied=%d, %s",
					captured, t.LagMs, qps, applied, t.CdcPosition),
			})
			// 契约第 3 条：每 tick 上报进度 + 批量日志
			s.publish(ctx, t, rep, &logs)
		}
	}
}

// cdcWalkQps currentQps 在 [cdcMinQps, cdcMaxQps] 内做有界随机游走（触界反弹，避免长期贴边）。
func cdcWalkQps(cur int64, rnd *rand.Rand) int64 {
	next := cur + int64(rnd.Intn(2*cdcQpsStep+1)-cdcQpsStep)
	if next < cdcMinQps {
		next = 2*int64(cdcMinQps) - next
	}
	if next > cdcMaxQps {
		next = 2*int64(cdcMaxQps) - next
	}
	if next < cdcMinQps {
		next = cdcMinQps
	}
	if next > cdcMaxQps {
		next = cdcMaxQps
	}
	return next
}

// cdcNextLagMs lagMs 在 300~3000 之间波动，约 2% 概率尖峰到 6000~9000（延迟告警演示）。
func cdcNextLagMs(rnd *rand.Rand) int64 {
	if rnd.Float64() < cdcLagSpikeProb {
		return int64(cdcLagSpikeMinMs + rnd.Intn(cdcLagSpikeRangeMs))
	}
	return int64(cdcMinLagMs + rnd.Intn(cdcMaxLagMs-cdcMinLagMs+1))
}

// pickCdcError 按源库类型挑一条 cdc mock 错误报文。
func pickCdcError(sourceType string, rnd *rand.Rand) string {
	if list, ok := mockCdcErrorsByType[sourceType]; ok && len(list) > 0 {
		return list[rnd.Intn(len(list))]
	}
	return mockCdcErrorsGeneric[rnd.Intn(len(mockCdcErrorsGeneric))]
}

// publish 写快照 -> 回报进度 -> 批量回报日志（回报失败只记日志，不中断任务）。
func (s *taskService) publish(ctx context.Context, t *model.MockTask, rep reporter.Reporter, logs *[]v1.LogItem) {
	snapshot := t.Clone()
	if err := s.repo.Save(ctx, snapshot); err != nil {
		s.logger.Warn("保存任务状态失败", zap.String("instanceId", t.InstanceID), zap.String("err", err.Error()))
	}
	if err := rep.Report(ctx, reportOf(snapshot)); err != nil {
		s.logger.Warn("回报进度失败（任务继续）",
			zap.String("instanceId", t.InstanceID), zap.String("reportUrl", t.ReportURL), zap.String("err", err.Error()))
	}
	s.flushLogs(ctx, rep, t.InstanceID, logs)
}

func (s *taskService) flushLogs(ctx context.Context, rep reporter.Reporter, instanceID string, logs *[]v1.LogItem) {
	if logs == nil || len(*logs) == 0 {
		return
	}
	if err := rep.ReportLogs(ctx, instanceID, *logs); err != nil {
		s.logger.Warn("回报日志失败（任务继续）",
			zap.String("instanceId", instanceID), zap.Int("logs", len(*logs)), zap.String("err", err.Error()))
	}
	*logs = (*logs)[:0]
}

// finish 进入终态（success/failed/stopped）并回报最后一次快照。
// 终态回报使用独立 context：停止指令已 cancel 任务上下文时仍要保证能发出去。
func (s *taskService) finish(ctx context.Context, t *model.MockTask, rep reporter.Reporter, status, message string, logs *[]v1.LogItem) {
	t.Finish(status, t.Progress, message)

	if logs == nil {
		empty := make([]v1.LogItem, 0, 2)
		logs = &empty
	}
	switch status {
	case model.StatusSuccess:
		*logs = append(*logs, v1.LogItem{
			Level:   "INFO",
			Message: fmt.Sprintf("sync finished: %d rows read, %d rows written, %d batches", t.ReadRows, t.WriteRows, t.BatchesDone),
		})
	case model.StatusFailed:
		*logs = append(*logs, v1.LogItem{Level: "ERROR", Message: message})
		if t.IsCdc() {
			*logs = append(*logs, v1.LogItem{
				Level: "ERROR",
				Message: fmt.Sprintf("pipeline failed after %d ticks, %d change events captured, position %s, instance %s",
					t.BatchesDone, t.ChangeRows, t.CdcPosition, t.InstanceID),
			})
		} else {
			*logs = append(*logs, v1.LogItem{
				Level:   "ERROR",
				Message: fmt.Sprintf("sync failed at batch %d/%d, instance %s", t.BatchesDone+1, t.TotalBatches(), t.InstanceID),
			})
		}
	case model.StatusStopped:
		if t.IsCdc() {
			*logs = append(*logs, v1.LogItem{
				Level: "WARN",
				Message: fmt.Sprintf("pipeline stopped after %d ticks, %d change events captured, position %s",
					t.BatchesDone, t.ChangeRows, t.CdcPosition),
			})
		} else {
			*logs = append(*logs, v1.LogItem{
				Level:   "WARN",
				Message: fmt.Sprintf("sync stopped at batch %d/%d, %d rows read", t.BatchesDone, t.TotalBatches(), t.ReadRows),
			})
		}
	}

	reportCtx, cancel := s.detachedReportContext(ctx)
	defer cancel()
	s.publish(reportCtx, t, rep, logs)

	s.prune(reportCtx)

	fields := []zap.Field{
		zap.String("instanceId", t.InstanceID),
		zap.String("taskId", t.TaskID),
		zap.String("syncMode", t.SyncMode),
		zap.String("status", status),
		zap.Int("progress", t.Progress),
		zap.Int64("readRows", t.ReadRows),
		zap.Int64("writeRows", t.WriteRows),
		zap.String("currentOffset", t.CurrentOffset),
		zap.String("message", message),
	}
	if t.IsCdc() {
		fields = append(fields,
			zap.String("pipelineId", t.PipelineID),
			zap.Int64("changeRows", t.ChangeRows),
			zap.Int64("currentQps", t.CurrentQps),
			zap.Int64("lagMs", t.LagMs),
			zap.String("cdcPosition", t.CdcPosition),
		)
	}
	s.logger.Info("task finished", fields...)
}

// planFailure 依据 failureRate 预先决定该任务是否失败以及失败批次（契约第 4 条）。
// cdc（数据管道）没有总批次概念，这里保持 FailAtBatch=0，由 runCdc 逐 tick 判定。
func (s *taskService) planFailure(t *model.MockTask) {
	t.FailAtBatch = 0
	t.FailMsg = ""
	if t.FailureRate <= 0 {
		return
	}
	total := t.TotalBatches()
	if total <= 0 {
		return
	}
	rnd := rand.New(rand.NewSource(time.Now().UnixNano()))
	if rnd.Float64() >= t.FailureRate {
		return
	}
	t.FailAtBatch = 1 + rnd.Intn(total)
	t.FailMsg = pickMockError(t.Source.Type, rnd)
}

func pickMockError(sourceType string, rnd *rand.Rand) string {
	if list, ok := mockErrorsByType[sourceType]; ok && len(list) > 0 {
		return list[rnd.Intn(len(list))]
	}
	return mockErrorsGeneric[rnd.Intn(len(mockErrorsGeneric))]
}

// nextOffset 推进模拟位点：
//   - 增量模式：以「1 行 = 1 秒」的窗口把 incrementalColumn 位点从任务开始前推进到当前时间；
//   - 全量模式：回报全量分片点位（已读行数对应的 ROWID 位置）。
func (s *taskService) nextOffset(t *model.MockTask) string {
	if t.SyncMode == model.SyncModeIncremental {
		col := t.IncrementalColumn
		if col == "" {
			col = "UPDATE_TIME"
		}
		window := time.Duration(t.TotalRows) * time.Second
		pos := t.StartedAt.Add(-window).Add(time.Duration(t.ReadRows) * time.Second)
		return fmt.Sprintf("%s=%s", col, pos.UTC().Format(time.RFC3339))
	}
	return fmt.Sprintf("ROWID=%010d", t.ReadRows)
}

// detachedReportContext 任务上下文已取消时改用 background，保证终态回报可以发出。
func (s *taskService) detachedReportContext(ctx context.Context) (context.Context, context.CancelFunc) {
	base := ctx
	if ctx.Err() != nil {
		base = context.Background()
	}
	return context.WithTimeout(base, s.opts.ReportTimeout)
}

func (s *taskService) releaseHandle(instanceID string, handle *runHandle) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.runs[instanceID]; ok && cur == handle {
		delete(s.runs, instanceID)
	}
}

// prune 终态实例快照保留上限治理：超出 MaxHistory 后淘汰最早结束的记录。
func (s *taskService) prune(ctx context.Context) {
	if s.opts.MaxHistory <= 0 {
		return
	}
	terminal := make([]*model.MockTask, 0, 8)
	for _, t := range s.repo.List(ctx) {
		if t.IsTerminal() {
			terminal = append(terminal, t)
		}
	}
	if len(terminal) <= s.opts.MaxHistory {
		return
	}
	sort.Slice(terminal, func(i, j int) bool {
		return finishedAtOf(terminal[i]).Before(finishedAtOf(terminal[j]))
	})
	excess := len(terminal) - s.opts.MaxHistory
	for _, t := range terminal[:excess] {
		s.mu.Lock()
		_, running := s.runs[t.InstanceID]
		s.mu.Unlock()
		if running {
			continue
		}
		if err := s.repo.Remove(ctx, t.InstanceID); err != nil {
			s.logger.Warn("清理历史实例失败", zap.String("instanceId", t.InstanceID), zap.String("err", err.Error()))
			continue
		}
		s.logger.Info("清理历史实例快照", zap.String("instanceId", t.InstanceID))
	}
}

func finishedAtOf(t *model.MockTask) time.Time {
	if t.FinishedAt != nil {
		return *t.FinishedAt
	}
	return t.StartedAt
}

func reportOf(t *model.MockTask) *v1.ProgressReport {
	r := &v1.ProgressReport{
		InstanceID:     t.InstanceID,
		TaskID:         t.TaskID,
		Status:         t.Status,
		Progress:       t.Progress,
		ReadRows:       t.ReadRows,
		WriteRows:      t.WriteRows,
		RateRowsPerSec: t.RateRowsPerSec,
	}
	if t.Message != nil && *t.Message != "" {
		msg := *t.Message
		r.Message = &msg
	}
	if t.IsCdc() {
		// 契约第 1.4 节：pipelineId/currentQps/lagMs/cdcPosition 仅 cdc 管道回报时携带，
		// 此时 progress 恒为 0、totalRows 不回报。
		if t.PipelineID != "" {
			pid := t.PipelineID
			r.PipelineID = &pid
		}
		qps, lag := t.CurrentQps, t.LagMs
		r.CurrentQps = &qps
		r.LagMs = &lag
		if t.CdcPosition != "" {
			pos := t.CdcPosition
			r.CdcPosition = &pos
		}
		return r
	}
	total := t.TotalRows
	r.TotalRows = &total
	if t.CurrentOffset != "" {
		offset := t.CurrentOffset
		r.CurrentOffset = &offset
	}
	return r
}

func readerSpecOf(t *model.MockTask) reader.Spec {
	return reader.Spec{
		InstanceID:        t.InstanceID,
		TaskID:            t.TaskID,
		TaskName:          t.TaskName,
		SyncMode:          t.SyncMode,
		SourceID:          t.Source.ID,
		SourceType:        t.Source.Type,
		Database:          t.Source.Database,
		Table:             t.SourceTable,
		IncrementalColumn: t.IncrementalColumn,
		BatchSize:         t.BatchSize,
		TotalRows:         t.TotalRows,
		// cdc：源端日志流没有终点，reader 不按 totalRows 截断
		Unbounded: t.IsCdc(),
	}
}

func writerSpecOf(t *model.MockTask) writer.Spec {
	return writer.Spec{
		InstanceID: t.InstanceID,
		TaskID:     t.TaskID,
		TaskName:   t.TaskName,
		SyncMode:   t.SyncMode,
		TargetID:   t.Target.ID,
		TargetType: t.Target.Type,
		Database:   t.Target.Database,
		Table:      t.TargetTable,
		WriteMode:  t.WriteMode,
		BatchSize:  t.BatchSize,
	}
}

func rowsPerSec(rows int64, elapsed, tick time.Duration) int64 {
	secs := elapsed.Seconds()
	if secs <= 0 {
		secs = tick.Seconds()
	}
	if secs <= 0 {
		secs = 1
	}
	return int64(float64(rows) / secs)
}
