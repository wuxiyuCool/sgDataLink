package dbio

import (
	"fmt"
	"strings"

	goora "github.com/sijms/go-ora/v2"
)

// oracleDialect Oracle 方言（go-ora 纯 Go 驱动，注册名 oracle）：
// 双引号标识符 + ":n" 位置绑定 + ROWNUM 分页（11g/12c 通用，不依赖 12c 的 OFFSET/FETCH）
// + 单行语句在事务内逐条执行（INSERT ALL 的收益不抵可读性/参数上限风险）。
type oracleDialect struct{}

const oracleDriverName = "oracle"

func (oracleDialect) name() string       { return TypeOracle }
func (oracleDialect) driverName() string { return oracleDriverName }

// placeholder go-ora 支持 :1 :2 … 形式的位置绑定，编号与传参顺序一一对应。
func (oracleDialect) placeholder(n int) string { return fmt.Sprintf(":%d", n) }

// quoteIdent 双引号转义：Oracle 里加引号即大小写敏感，
// 因此上层先用数据字典（ALL_TAB_COLUMNS）把列名/表名对齐成真实大小写再进来引用。
func (oracleDialect) quoteIdent(id string) string {
	return `"` + strings.ReplaceAll(id, `"`, `""`) + `"`
}

func (d oracleDialect) quoteTable(ep Endpoint) string {
	schema, table := splitTable(ep.Table)
	if schema == "" {
		return d.quoteIdent(d.dictionaryName(ep.defaultSchema())) + "." + d.quoteIdent(d.dictionaryName(table))
	}
	return d.quoteIdent(d.dictionaryName(schema)) + "." + d.quoteIdent(d.dictionaryName(table))
}

// dictionaryName Oracle 未加引号创建的对象在数据字典里恒为大写。
func (oracleDialect) dictionaryName(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }

// connectString DSN：oracle://user:pass@host:port/service（BuildUrl 负责特殊字符转义，
// 口令里的 @ / # 等不会破坏解析）。
func (oracleDialect) connectString(ep Endpoint) (string, error) {
	if err := ep.Validate(); err != nil {
		return "", err
	}
	service := strings.TrimSpace(ep.Database)
	if service == "" {
		return "", fmt.Errorf("dbio: oracle.database（service name 或 SID）必填")
	}
	return goora.BuildUrl(ep.Host, ep.Port, service, ep.Username, ep.Password, nil), nil
}

func (d oracleDialect) countSQL(ep Endpoint) string {
	return "SELECT COUNT(*) FROM " + d.quoteTable(ep)
}

func (d oracleDialect) probeSQL(ep Endpoint, cols []string) string {
	return "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep) + " WHERE 1 <> 1"
}

func (d oracleDialect) countAfterSQL(ep Endpoint, col string, after any) (string, []any) {
	if after == nil {
		return d.countSQL(ep), nil
	}
	b := newBindArgs(d)
	return "SELECT COUNT(*) FROM " + d.quoteTable(ep) + " WHERE " + d.quoteIdent(col) + " > " + b.push(after), b.args
}

// pageSQL ROWNUM 嵌套分页：内层排序 -> 中层 ROWNUM <= offset+limit -> 外层 RN_ > offset。
// 额外输出的 RN_ 列只存在于中间层，最外层仍只选业务列。
func (d oracleDialect) pageSQL(ep Endpoint, cols []string, orderBy []string, limit int, offset int64) (string, []any) {
	b := newBindArgs(d)
	upper := b.push(offset + int64(limit))
	lower := b.push(offset)
	inner := "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep)
	if len(orderBy) > 0 {
		inner += " ORDER BY " + joinQuoted(d, orderBy)
	}
	return "SELECT " + joinQuoted(d, cols) + " FROM (SELECT " + joinQuoted(d, cols) + ", ROWNUM RN_ FROM (" +
		inner + ") SRC_ WHERE ROWNUM <= " + upper + ") WRAP_ WHERE RN_ > " + lower, b.args
}

// keysetSQL 游标分页：先按 col 排序取前缀，再用 ROWNUM 限行（after 为 nil 表示首轮）。
func (d oracleDialect) keysetSQL(ep Endpoint, cols []string, col string, after any, limit int) (string, []any) {
	b := newBindArgs(d)
	inner := "SELECT " + joinQuoted(d, cols) + " FROM " + d.quoteTable(ep)
	if after != nil {
		inner += " WHERE " + d.quoteIdent(col) + " > " + b.push(after)
	}
	inner += " ORDER BY " + d.quoteIdent(col)
	cap := b.push(limit)
	return "SELECT " + joinQuoted(d, cols) + " FROM (" + inner + ") SRC_ WHERE ROWNUM <= " + cap, b.args
}

func (oracleDialect) serverTimeSQL() string { return "SELECT SYSDATE FROM DUAL" }

// columnMetaSQL ALL_TAB_COLUMNS 的 owner / table_name 均为大写，绑定传参。
func (d oracleDialect) columnMetaSQL(ep Endpoint) (string, []any) {
	schema, table := splitTable(ep.Table)
	if schema == "" {
		schema = ep.defaultSchema()
	}
	return "SELECT COLUMN_NAME, DATA_TYPE FROM ALL_TAB_COLUMNS " +
			"WHERE OWNER = :1 AND TABLE_NAME = :2 ORDER BY COLUMN_ID",
		[]any{d.dictionaryName(schema), d.dictionaryName(table)}
}

// multiRow oracle 走「逐条同事务」，由 Writer 在一个事务里复用预处理语句。
func (oracleDialect) multiRow() bool { return false }

// primaryKeyMetaSQL 主键约束列（ALL_CONSTRAINTS + ALL_CONS_COLUMNS，按 POSITION 排序）。
func (d oracleDialect) primaryKeyMetaSQL(ep Endpoint) (string, []any) {
	schema, table := splitTable(ep.Table)
	if schema == "" {
		schema = ep.defaultSchema()
	}
	return "SELECT CC.COLUMN_NAME FROM ALL_CONSTRAINTS C " +
			"JOIN ALL_CONS_COLUMNS CC ON CC.OWNER = C.OWNER AND CC.CONSTRAINT_NAME = C.CONSTRAINT_NAME " +
			"WHERE C.OWNER = :1 AND C.TABLE_NAME = :2 AND C.CONSTRAINT_TYPE = 'P' ORDER BY CC.POSITION",
		[]any{d.dictionaryName(schema), d.dictionaryName(table)}
}

func (oracleDialect) maxRowPerStatement(int) int { return 1 }

// clearSQL overwrite 语义：Oracle 无 TRUNCATE 的事务等价物（TRUNCATE 是 DDL，会隐式提交且需
// DROP ANY TABLE 权限），故用 DELETE FROM 保证与批插处于同一事务、失败可回滚。
func (d oracleDialect) clearSQL(ep Endpoint) string { return "DELETE FROM " + d.quoteTable(ep) }

func (d oracleDialect) insertSQL(ep Endpoint, cols []string, _ int) string {
	n := len(cols)
	holder := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		holder = append(holder, d.placeholder(i))
	}
	return "INSERT INTO " + d.quoteTable(ep) + " (" + joinQuoted(d, cols) + ") VALUES (" +
		strings.Join(holder, ", ") + ")"
}

// upsertSQL 单行 MERGE：USING (SELECT :n AS "COL" … FROM DUAL) 造出一行源，
// ON 用主键列匹配；WHEN MATCHED 只更新非主键列（更新 ON 列会触发 ORA-38104）。
// 占位符编号即列在 cols 中的序号，执行时按同一顺序传值。
func (d oracleDialect) upsertSQL(ep Endpoint, cols, pkCols []string, _ int) string {
	src := make([]string, 0, len(cols))
	for i, c := range cols {
		src = append(src, d.placeholder(i+1)+" AS "+d.quoteIdent(c))
	}
	on := make([]string, 0, len(pkCols))
	for _, c := range pkCols {
		on = append(on, "TGT."+d.quoteIdent(c)+" = SRC."+d.quoteIdent(c))
	}
	update := make([]string, 0, len(cols))
	for _, c := range cols {
		if !containsFold(pkCols, c) {
			update = append(update, "TGT."+d.quoteIdent(c)+" = SRC."+d.quoteIdent(c))
		}
	}
	insertCols := joinQuoted(d, cols)
	insertVals := make([]string, 0, len(cols))
	for _, c := range cols {
		insertVals = append(insertVals, "SRC."+d.quoteIdent(c))
	}
	sql := "MERGE INTO " + d.quoteTable(ep) + " TGT USING (SELECT " + strings.Join(src, ", ") +
		" FROM DUAL) SRC ON (" + strings.Join(on, " AND ") + ")"
	if len(update) > 0 {
		sql += " WHEN MATCHED THEN UPDATE SET " + strings.Join(update, ", ")
	}
	sql += " WHEN NOT MATCHED THEN INSERT (" + insertCols + ") VALUES (" + strings.Join(insertVals, ", ") + ")"
	return sql
}

// upsertFallbackSQL 全列皆主键时 MERGE 没有可更新列 -> 改用 DELETE + INSERT 达成幂等 upsert。
// DELETE 的占位符编号与 pkCols 顺序一致，执行时只传主键值。
func (d oracleDialect) upsertFallbackSQL(ep Endpoint, cols, pkCols []string) (string, string) {
	where := make([]string, 0, len(pkCols))
	for i, c := range pkCols {
		where = append(where, d.quoteIdent(c)+" = "+d.placeholder(i+1))
	}
	return "DELETE FROM " + d.quoteTable(ep) + " WHERE " + strings.Join(where, " AND "),
		d.insertSQL(ep, cols, 1)
}
