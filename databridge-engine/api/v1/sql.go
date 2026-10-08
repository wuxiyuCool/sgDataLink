package v1

import (
	"errors"
	"fmt"
	"strings"
)

// 通用 SQL 执行接口业务码（docs/API.md 第 2 节「通用 SQL 执行接口」，契约 v1.12）。
const (
	// CodeEngineToken X-Engine-Token 缺失/不匹配 -> HTTP 401
	CodeEngineToken = 40101
	// CodeSQLExecFail SQL 在目标库执行失败 -> HTTP 502（message 透传库错误，已去密码）
	CodeSQLExecFail = 50002
)

// SQLQueryRequest POST /api/v1/engine/sql/query 请求体。
type SQLQueryRequest struct {
	Endpoint   EndpointDTO `json:"endpoint" binding:"required"`
	SQL        string      `json:"sql" binding:"required"`
	Limit      int         `json:"limit" binding:"omitempty,min=1,max=100000"`
	TimeoutSec int         `json:"timeoutSec" binding:"omitempty,min=1,max=120"`
}

// SQLQueryData query 接口 data。
type SQLQueryData struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	RowCount  int      `json:"rowCount"`
	ElapsedMs int64    `json:"elapsedMs"`
}

// SQLExecRequest POST /api/v1/engine/sql/exec 请求体。
// 携带 reportUrl 时异步执行（立即 accepted，完成后按 1.4 ProgressReport 回报）。
type SQLExecRequest struct {
	InstanceID string      `json:"instanceId" binding:"required"`
	Endpoint   EndpointDTO `json:"endpoint" binding:"required"`
	Statements []string    `json:"statements" binding:"required,min=1,max=50"`
	ReportURL  string      `json:"reportUrl" binding:"omitempty,url"`
}

// SQLExecResult 单条语句的执行结果（同步模式）。
type SQLExecResult struct {
	AffectedRows int64 `json:"affectedRows"`
	ElapsedMs    int64 `json:"elapsedMs"`
}

// SQLExecData exec 同步模式 data。
type SQLExecData struct {
	Results []SQLExecResult `json:"results"`
}

// SQLExecAcceptedData exec 异步模式 data。
type SQLExecAcceptedData struct {
	Accepted   bool   `json:"accepted"`
	InstanceID string `json:"instanceId"`
}

const (
	sqlDefaultQueryLimit = 1000
	sqlDefaultTimeoutSec = 30
)

// normalizeSQL 去首尾空白与结尾分号；内部仍含分号视为多语句拼接。
func normalizeSQL(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	text = strings.TrimRight(text, "; \t\r\n")
	if text == "" {
		return "", errors.New("sql 不能为空")
	}
	if strings.Contains(text, ";") {
		return "", errors.New("sql 不允许多语句拼接（分号）")
	}
	return text, nil
}

// flatHead 取首个「动词短语」用于白名单比对：压缩空白并转大写。
func flatHead(text string) string {
	return strings.ToUpper(strings.Join(strings.Fields(text), " "))
}

// Validate query 守卫：单语句且必须以 SELECT 开头；端点仅 mysql/oracle 且连接字段齐全。
func (r *SQLQueryRequest) Validate() error {
	sql, err := normalizeSQL(r.SQL)
	if err != nil {
		return err
	}
	r.SQL = sql
	if !strings.HasPrefix(flatHead(sql), "SELECT") {
		return fmt.Errorf("sql/query 仅允许 SELECT 语句")
	}
	if err := validateSQLConnEndpoint(r.Endpoint); err != nil {
		return err
	}
	if r.Limit <= 0 {
		r.Limit = sqlDefaultQueryLimit
	}
	if r.TimeoutSec <= 0 {
		r.TimeoutSec = sqlDefaultTimeoutSec
	}
	return nil
}

// Validate exec 守卫：每条语句首关键字 ∈ {CREATE TABLE, TRUNCATE TABLE, INSERT INTO,
// ALTER TABLE(仅 ADD 列)}；DROP/DELETE/UPDATE/GRANT 等一律拒绝。
func (r *SQLExecRequest) Validate() error {
	if err := validateSQLConnEndpoint(r.Endpoint); err != nil {
		return err
	}
	cleaned := make([]string, 0, len(r.Statements))
	for i, raw := range r.Statements {
		text, err := normalizeSQL(raw)
		if err != nil {
			return fmt.Errorf("statements[%d]: %w", i, err)
		}
		head := flatHead(text)
		switch {
		case strings.HasPrefix(head, "CREATE TABLE"),
			strings.HasPrefix(head, "TRUNCATE TABLE"),
			strings.HasPrefix(head, "INSERT INTO"):
		case strings.HasPrefix(head, "ALTER TABLE") && strings.Contains(head, " ADD "):
		default:
			return fmt.Errorf("statements[%d]: 首关键字不在白名单 {CREATE TABLE, TRUNCATE TABLE, INSERT INTO, ALTER TABLE ADD}，当前为 %q", i, firstWords(head, 3))
		}
		cleaned = append(cleaned, text)
	}
	r.Statements = cleaned
	return nil
}

// validateSQLConnEndpoint SQL 接口的端点最小必填集（与真实同步不同：不要求 table）。
func validateSQLConnEndpoint(ep EndpointDTO) error {
	if strings.TrimSpace(ep.Host) == "" {
		return errors.New("endpoint.host: 必填")
	}
	if strings.TrimSpace(ep.Username) == "" {
		return errors.New("endpoint.username: 必填")
	}
	if strings.TrimSpace(ep.Database) == "" {
		return errors.New("endpoint.database: 必填")
	}
	t := strings.ToLower(strings.TrimSpace(ep.Type))
	if t != "mysql" && t != "oracle" {
		return fmt.Errorf("endpoint.type: SQL 接口仅支持 mysql / oracle，当前为 %q", ep.Type)
	}
	return nil
}

func firstWords(head string, n int) string {
	parts := strings.SplitN(head, " ", n+1)
	if len(parts) > n {
		parts = parts[:n]
	}
	return strings.Join(parts, " ")
}
