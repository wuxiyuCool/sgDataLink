package dbio

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// ConnectTimeout 建连 + 握手（Ping）的超时，两种方言共用。
var ConnectTimeout = 15 * time.Second

// dialect 方言接口：所有 SQL 文本差异与绑定参数占位符差异都收敛在这里。
//
// 约定：每个返回 (sql, args) 的方法，args 顺序必须与 SQL 里占位符出现顺序严格一致，
// 因此占位符一律由 d.placeholder(n)（n 从 1 开始）现场生成，不做字符串替换。
type dialect interface {
	name() string
	driverName() string
	// connectString 生成 database/sql 的 DSN（含明文密码，仅在进程内使用）
	connectString(ep Endpoint) (string, error)
	// placeholder 第 n 个绑定参数占位符：mysql 恒为 "?"，oracle 为 ":n"
	placeholder(n int) string
	quoteIdent(id string) string
	quoteTable(ep Endpoint) string

	// --- 读侧 ---
	countSQL(ep Endpoint) string
	countAfterSQL(ep Endpoint, col string, after any) (string, []any)
	// pageSQL 全量分页：mysql LIMIT ? OFFSET ?；oracle ROWNUM 嵌套（11g/12c 通用）
	pageSQL(ep Endpoint, cols []string, orderBy []string, limit int, offset int64) (string, []any)
	// keysetSQL 游标分页：col > after ORDER BY col 取前 limit 行（after 为 nil 时不带 WHERE）
	keysetSQL(ep Endpoint, cols []string, col string, after any, limit int) (string, []any)
	// probeSQL 只取列不取行：EnsureWritable 用它提前暴露「表不存在 / 列名写错」
	probeSQL(ep Endpoint, cols []string) string
	serverTimeSQL() string
	// columnMetaSQL 查数据字典取列名与类型（用于标识符大小写对齐 + 位点类型还原）
	columnMetaSQL(ep Endpoint) (string, []any)
	// primaryKeyMetaSQL 查数据字典取主键列（按约束内顺序）
	primaryKeyMetaSQL(ep Endpoint) (string, []any)

	// --- 写侧 ---
	// multiRow 是否支持单语句多值批插（mysql true / oracle false，oracle 走「逐条同事务」）
	multiRow() bool
	// maxRowPerStatement 单语句最多承载的行数（受绑定参数上限约束），<=0 表示不限
	maxRowPerStatement(cols int) int
	clearSQL(ep Endpoint) string
	insertSQL(ep Endpoint, cols []string, rows int) string
	// upsertSQL 冲突更新语句：mysql ON DUPLICATE KEY UPDATE；oracle MERGE INTO ... USING (SELECT ... FROM DUAL)
	upsertSQL(ep Endpoint, cols, pkCols []string, rows int) string
	// upsertFallbackSQL 无可更新列（全列皆主键）时的替代语句：oracle 用 DELETE+INSERT 规避 ORA-38104
	upsertFallbackSQL(ep Endpoint, cols, pkCols []string) (deleteSQL, insertSQL string)
}

// newDialect 按端点类型挑方言。
func newDialect(ep Endpoint) (dialect, error) {
	switch ep.DBType() {
	case TypeMySQL:
		return &mysqlDialect{}, nil
	case TypeOracle:
		return &oracleDialect{}, nil
	default:
		return nil, fmt.Errorf("dbio: 不支持的数据库类型 %q", ep.Type)
	}
}

// openPooled 打开连接池并做一次真实握手；错误消息已去密码。
func openPooled(ctx context.Context, ep Endpoint, d dialect) (*sql.DB, error) {
	dsn, err := d.connectString(ep)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(d.driverName(), dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 %s 连接失败: %s", ep.Label(), redact(err.Error(), ep.Password))
	}
	// 单个 runner 同一时刻只需要 1 条读连接 + 1 条事务连接，池子刻意收得很小
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)

	pingCtx, cancel := withTimeout(ctx, ConnectTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("连接 %s 失败: %s", ep.Label(), redact(err.Error(), ep.Password))
	}
	return db, nil
}

// joinQuoted 用方言引用符把标识符列表拼成逗号分隔串。
func joinQuoted(d dialect, ids []string) string {
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, d.quoteIdent(id))
	}
	return strings.Join(parts, ", ")
}

// bindArgs 供各 SQL 构造器使用的绑定参数累加器（编号从 1 起，与占位符同步递增）。
type bindArgs struct {
	d    dialect
	n    int
	args []any
}

func newBindArgs(d dialect) *bindArgs { return &bindArgs{d: d} }

// add 追加一个绑定参数并返回其占位符。
func (b *bindArgs) add(v any) string {
	b.n++
	b.args = append(b.args, v)
	return b.d.placeholder(b.n)
}

func (b *bindArgs) push(v any) string { return b.add(v) }

// withTimeout 在父 ctx 之上加一次短超时（建连 / 元数据查询用）。
func withTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if d <= 0 {
		d = 15 * time.Second
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, d)
}

// valueScan 把驱动返回的值归一化：[]byte -> string（DECIMAL/CLOB 等在两种驱动里都常见以
// 字节切片返回），其余原样保留（time.Time / int64 / float64 / nil）。
func valueScan(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

// scanAll 一次性把结果集物化成 []map[string]any，并返回列序（驱动给出的实际列名）。
func scanAll(rows *sql.Rows) ([]map[string]any, []string, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	out := make([]map[string]any, 0, 32)
	raw := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range raw {
		ptrs[i] = &raw[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, nil, err
		}
		row := make(map[string]any, len(cols))
		for i, c := range cols {
			row[c] = valueScan(raw[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return out, cols, nil
}
