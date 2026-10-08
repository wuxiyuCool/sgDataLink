package service

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	v1 "databridge-engine/api/v1"
	"databridge-engine/internal/infra/dbio"
	"databridge-engine/internal/infra/reporter"
	"databridge-engine/pkg/log"

	"go.uber.org/zap"
)

// SQLService 通用 SQL 执行接口（docs/API.md 第 2 节「通用 SQL 执行接口」，契约 v1.12）。
// 语句白名单守卫已在 api/v1 DTO Validate 完成，这里只负责连接与执行。
type SQLService interface {
	Query(ctx context.Context, req *v1.SQLQueryRequest) (*v1.SQLQueryData, error)
	// Exec 同步返回 *v1.SQLExecData；req.ReportURL 非空时立即返回 accepted 并异步回报
	Exec(ctx context.Context, req *v1.SQLExecRequest) (any, error)
}

type SQLDeps struct {
	Reports reporter.Builder
	Logger  *log.Logger
}

type sqlService struct {
	deps SQLDeps
}

var _ SQLService = (*sqlService)(nil)

func NewSQLService(deps SQLDeps) SQLService {
	if deps.Logger == nil {
		deps.Logger = log.DefaultLogger()
	}
	return &sqlService{deps: deps}
}

func sqlEndpoint(ep v1.EndpointDTO) dbio.Endpoint {
	port := ep.Port
	if port <= 0 {
		if strings.EqualFold(strings.TrimSpace(ep.Type), "oracle") {
			port = 1521
		} else {
			port = 3306
		}
	}
	return dbio.Endpoint{
		Type:     strings.ToLower(strings.TrimSpace(ep.Type)),
		Host:     strings.TrimSpace(ep.Host),
		Port:     port,
		Database: strings.TrimSpace(ep.Database),
		Username: strings.TrimSpace(ep.Username),
		Password: ep.Password,
		Table:    "-", // SQL 文本自带表引用；Table 仅用于 Label，且 ValidateConnect 不校验
	}
}

// Query 执行单条 SELECT，返回列名与行数组（值统一转字符串/数字，时间用 RFC3339）。
func (s *sqlService) Query(ctx context.Context, req *v1.SQLQueryRequest) (*v1.SQLQueryData, error) {
	ep := sqlEndpoint(req.Endpoint)
	started := time.Now()

	db, err := dbio.OpenSingle(ctx, ep)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, err.Error())
	}
	defer db.Close()

	execCtx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutSec)*time.Second)
	defer cancel()

	rows, err := db.QueryContext(execCtx, req.SQL)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, dbio.Redact(err.Error(), ep.Password))
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, dbio.Redact(err.Error(), ep.Password))
	}
	data := &v1.SQLQueryData{Columns: cols, Rows: [][]any{}}
	for rows.Next() {
		if len(data.Rows) >= req.Limit {
			break
		}
		Scan := make([]any, len(cols))
		holders := make([]any, len(cols))
		for i := range Scan {
			holders[i] = &Scan[i]
		}
		if err := rows.Scan(holders...); err != nil {
			return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, dbio.Redact(err.Error(), ep.Password))
		}
		row := make([]any, 0, len(cols))
		for _, v := range Scan {
			row = append(row, normalizeValue(v))
		}
		data.Rows = append(data.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, dbio.Redact(err.Error(), ep.Password))
	}
	data.RowCount = len(data.Rows)
	data.ElapsedMs = time.Since(started).Milliseconds()
	return data, nil
}

// normalizeValue 驱动返回值归一：[]byte -> string（decimal/json），时间 -> RFC3339Nano 字符串。
func normalizeValue(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.Format(time.RFC3339Nano)
	case sql.NullInt64:
		if t.Valid {
			return t.Int64
		}
		return nil
	default:
		return v
	}
}

// Exec 依序执行语句。ReportURL 非空 -> 异步：立即 accepted，完成后按 1.4 ProgressReport 回报。
func (s *sqlService) Exec(ctx context.Context, req *v1.SQLExecRequest) (any, error) {
	if strings.TrimSpace(req.ReportURL) != "" {
		payload := *req
		go s.runAsync(&payload)
		return &v1.SQLExecAcceptedData{Accepted: true, InstanceID: payload.InstanceID}, nil
	}
	results, err := s.runStatements(ctx, req)
	if err != nil {
		return nil, err
	}
	return &v1.SQLExecData{Results: results}, nil
}

func (s *sqlService) runStatements(ctx context.Context, req *v1.SQLExecRequest) ([]v1.SQLExecResult, error) {
	ep := sqlEndpoint(req.Endpoint)
	db, err := dbio.OpenSingle(ctx, ep)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrSQLExecFail, err.Error())
	}
	defer db.Close()

	results := make([]v1.SQLExecResult, 0, len(req.Statements))
	for i, statement := range req.Statements {
		execCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		started := time.Now()
		res, err := db.ExecContext(execCtx, statement)
		elapsed := time.Since(started).Milliseconds()
		cancel()
		if err != nil {
			return nil, fmt.Errorf("%w: statements[%d]: %s", ErrSQLExecFail, i, dbio.Redact(err.Error(), ep.Password))
		}
		affected := int64(0)
		if n, err := res.RowsAffected(); err == nil {
			affected = n
		}
		results = append(results, v1.SQLExecResult{AffectedRows: affected, ElapsedMs: elapsed})
	}
	return results, nil
}

// runAsync 异步执行 + 1.4 回报（running -> 终态），回报失败只记日志。
func (s *sqlService) runAsync(req *v1.SQLExecRequest) {
	ctx := context.Background()
	rep := s.deps.Reports.Build(req.ReportURL)
	report := func(status string, writeRows int64, message string) {
		payload := &v1.ProgressReport{
			InstanceID: req.InstanceID,
			Status:     status,
			WriteRows:  writeRows,
			Message:    &message,
		}
		if err := rep.Report(ctx, payload); err != nil {
			s.deps.Logger.Warn("sql exec report failed",
				zap.String("instanceId", req.InstanceID), zap.String("err", err.Error()))
		}
	}
	report("running", 0, "")

	results, err := s.runStatements(ctx, req)
	if err != nil {
		s.deps.Logger.Error("async sql exec failed",
			zap.String("instanceId", req.InstanceID), zap.String("err", err.Error()))
		message := dbio.TruncateMessage(err.Error())
		report("failed", 0, message)
		return
	}
	var total int64
	for _, r := range results {
		total += r.AffectedRows
	}
	report("success", total, "")
}
