package dbio

import (
	"fmt"
	"strings"

	// 注册 database/sql 驱动名 "mysql"（契约第 5 节：mysql -> go-sql-driver/mysql）
	_ "github.com/go-sql-driver/mysql"
)

// mysqlDialect MySQL 8.x/5.7 方言：反引号标识符 + "?" 位置绑定 + 单语句多值批插。
type mysqlDialect struct{}

const mysqlDriverName = "mysql"

func (mysqlDialect) name() string           { return TypeMySQL }
func (mysqlDialect) driverName() string     { return mysqlDriverName }
func (mysqlDialect) placeholder(int) string { return "?" }

// quoteIdent 反引号转义：内部的反引号按 MySQL 规则翻倍。
func (mysqlDialect) quoteIdent(id string) string {
	return "`" + strings.ReplaceAll(id, "`", "``") + "`"
}

func (d mysqlDialect) quoteTable(ep Endpoint) string {
	schema, table := splitTable(ep.Table)
	if schema == "" {
		return d.quoteIdent(table)
	}
	return d.quoteIdent(schema) + "." + d.quoteIdent(table)
}

// connectString DSN：user:pass@tcp(host:port)/db?parseTime=true&charset=utf8mb4
// （parseTime 让 DATETIME/TIMESTAMP 直接落成 time.Time，供位点比较使用）。
func (mysqlDialect) connectString(ep Endpoint) (string, error) {
	if err := ep.Validate(); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?parseTime=true&charset=utf8mb4",
		ep.Username, ep.Password, ep.Host, ep.Port, strings.TrimSpace(ep.Database)), nil
}

func (d mysqlDialect) countSQL(ep Endpoint) string {
	return "SELECT COUNT(*) FROM " + d.quoteTable(ep)
}

func (d mysqlDialect) probeSQL(ep Endpoint, cols []string) string {
	return "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep) + " WHERE 1 <> 1"
}

func (d mysqlDialect) countAfterSQL(ep Endpoint, col string, after any) (string, []any) {
	if after == nil {
		return d.countSQL(ep), nil
	}
	b := newBindArgs(d)
	p := b.push(after)
	return "SELECT COUNT(*) FROM " + d.quoteTable(ep) + " WHERE " + d.quoteIdent(col) + " > " + p, b.args
}

// pageSQL 全量分页：ORDER BY pk LIMIT ? OFFSET ?（无 ORDER BY 时 OFFSET 翻页不保证稳定，
// 上层在没有主键映射时会退化为按首列排序）。
func (d mysqlDialect) pageSQL(ep Endpoint, cols []string, orderBy []string, limit int, offset int64) (string, []any) {
	b := newBindArgs(d)
	lim := b.push(limit)
	off := b.push(offset)
	sql := "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep)
	if len(orderBy) > 0 {
		sql += " ORDER BY " + joinQuoted(d, orderBy)
	}
	return sql + " LIMIT " + lim + " OFFSET " + off, b.args
}

func (d mysqlDialect) keysetSQL(ep Endpoint, cols []string, col string, after any, limit int) (string, []any) {
	b := newBindArgs(d)
	sql := "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep)
	if after != nil {
		sql += " WHERE " + d.quoteIdent(col) + " > " + b.push(after)
	}
	lim := b.push(limit)
	return sql + " ORDER BY " + d.quoteIdent(col) + " LIMIT " + lim, b.args
}

func (mysqlDialect) serverTimeSQL() string { return "SELECT NOW()" }

// columnMetaSQL 走 information_schema，库名/表名全部绑定传参。
func (mysqlDialect) columnMetaSQL(ep Endpoint) (string, []any) {
	_, table := splitTable(ep.Table)
	return "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS " +
			"WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
		[]any{ep.schemaOf(), table}
}

// primaryKeyMetaSQL 主键列（COLUMN_KEY='PRI' 即主键的一部分，ORDINAL_POSITION 给约束内顺序）。
func (mysqlDialect) primaryKeyMetaSQL(ep Endpoint) (string, []any) {
	_, table := splitTable(ep.Table)
	return "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE " +
		"WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' " +
		"ORDER BY ORDINAL_POSITION", []any{ep.schemaOf(), table}
}

// multiRow MySQL 支持单条 INSERT 挂多组 VALUES，吞吐显著优于逐条执行。
func (mysqlDialect) multiRow() bool { return true }

// maxRowPerStatement 预编译语句的占位符总数上限（服务端上限 65535，留出余量）。
func (mysqlDialect) maxRowPerStatement(cols int) int {
	if cols <= 0 {
		return 1
	}
	n := 60000 / cols
	if n < 1 {
		n = 1
	}
	return n
}

// clearSQL overwrite 语义：TRUNCATE（比 DELETE 快且重置自增；需要 DROP 权限）。
func (d mysqlDialect) clearSQL(ep Endpoint) string { return "TRUNCATE TABLE " + d.quoteTable(ep) }

func (d mysqlDialect) insertSQL(ep Endpoint, cols []string, rows int) string {
	if rows < 1 {
		rows = 1
	}
	group := "(" + strings.TrimSuffix(strings.Repeat(d.placeholder(1)+",", len(cols)), ",") + ")"
	groups := make([]string, 0, rows)
	for i := 0; i < rows; i++ {
		groups = append(groups, group)
	}
	return "INSERT INTO " + d.quoteTable(ep) + " (" + joinQuoted(d, cols) + ") VALUES " +
		strings.Join(groups, ",")
}

// upsertSQL 依赖目标表上的唯一键/主键（由 fieldMappings[].primaryKey 指明列）。
// 无业务主键之外列时，用 TGT.PK = VALUES(PK) 作为合法的无更新占位。
func (d mysqlDialect) upsertSQL(ep Endpoint, cols, pkCols []string, rows int) string {
	sql := d.insertSQL(ep, cols, rows)
	update := make([]string, 0, len(cols))
	for _, c := range cols {
		if !containsFold(pkCols, c) {
			update = append(update, d.quoteIdent(c)+" = VALUES("+d.quoteIdent(c)+")")
		}
	}
	if len(update) == 0 {
		if len(pkCols) == 0 {
			update = append(update, d.quoteIdent(cols[0])+" = VALUES("+d.quoteIdent(cols[0])+")")
		} else {
			pk := pkCols[0]
			update = append(update, d.quoteIdent(pk)+" = VALUES("+d.quoteIdent(pk)+")")
		}
	}
	return sql + " ON DUPLICATE KEY UPDATE " + strings.Join(update, ", ")
}

// upsertFallbackSQL MySQL 全主键表可直接用 ON DUPLICATE KEY UPDATE 占位，无需 DELETE+INSERT。
func (d mysqlDialect) upsertFallbackSQL(ep Endpoint, cols, pkCols []string) (string, string) {
	return "", d.upsertSQL(ep, cols, pkCols, 1)
}

func containsFold(list []string, want string) bool {
	for _, v := range list {
		if strings.EqualFold(v, want) {
			return true
		}
	}
	return false
}
