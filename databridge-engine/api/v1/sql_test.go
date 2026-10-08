package v1

import (
	"strings"
	"testing"
)

func mysqlEndpoint() EndpointDTO {
	return EndpointDTO{ID: "ds-1", Type: "mysql", Host: "10.45.34.222", Port: 3306, Database: "dataLink", Username: "root", Password: "x"}
}

func TestSQLQueryValidate(t *testing.T) {
	cases := []struct {
		name    string
		sql     string
		wantErr string
	}{
		{"普通 SELECT", "SELECT 1 FROM t", ""},
		{"大小写混排", "select id from t limit 10", ""},
		{"尾部分号允许", "SELECT 1;", ""},
		{"多语句拒绝", "SELECT 1; DROP TABLE t", "多语句"},
		{"DROP 拒绝", "DROP TABLE t", "仅允许 SELECT"},
		{"UPDATE 拒绝", "UPDATE t SET a=1", "仅允许 SELECT"},
		{"INSERT 拒绝（query 侧）", "INSERT INTO t VALUES(1)", "仅允许 SELECT"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := &SQLQueryRequest{Endpoint: mysqlEndpoint(), SQL: c.sql}
			err := req.Validate()
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if req.Limit != sqlDefaultQueryLimit || req.TimeoutSec != sqlDefaultTimeoutSec {
					t.Fatalf("defaults not applied: limit=%d timeout=%d", req.Limit, req.TimeoutSec)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}
}

func TestSQLExecValidate(t *testing.T) {
	cases := []struct {
		name    string
		statements []string
		wantErr string
	}{
		{"建表+清空+插入允许", []string{"CREATE TABLE IF NOT EXISTS t (id INT)", "TRUNCATE TABLE t", "INSERT INTO t (id) SELECT 1"}, ""},
		{"ALTER ADD COLUMN 允许", []string{"ALTER TABLE t ADD COLUMN c1 VARCHAR(8)"}, ""},
		{"ALTER DROP 拒绝", []string{"ALTER TABLE t DROP COLUMN c1"}, "白名单"},
		{"DELETE 拒绝", []string{"DELETE FROM t"}, "白名单"},
		{"UPDATE 拒绝", []string{"UPDATE t SET a=1"}, "白名单"},
		{"DROP TABLE 拒绝", []string{"DROP TABLE t"}, "白名单"},
		{"分号拼接拒绝", []string{"SELECT 1; SELECT 2"}, "多语句"},
		{"空语句拒绝", []string{"  "}, "不能为空"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := &SQLExecRequest{InstanceID: "mtr-1", Endpoint: mysqlEndpoint(), Statements: c.statements}
			err := req.Validate()
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}
}

func TestSQLEndpointGuard(t *testing.T) {
	ep := mysqlEndpoint()
	ep.Type = "postgresql"
	req := &SQLQueryRequest{Endpoint: ep, SQL: "SELECT 1"}
	if err := req.Validate(); err == nil || !strings.Contains(err.Error(), "仅支持 mysql / oracle") {
		t.Fatalf("postgresql must be rejected, got %v", err)
	}
}
