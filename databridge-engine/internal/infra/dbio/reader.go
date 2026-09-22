package dbio

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Cursor 源库读位置，两种取数模式二选一：
//   - 全量（Col 为空）：按 OrderBy 稳定排序后 Offset 翻页；
//   - 增量 / 管道（Col 非空）：WHERE Col > After ORDER BY Col 取前 Limit 行（After 为 nil 表示从头）。
type Cursor struct {
	Offset  int64
	OrderBy []string
	Col     string
	After   any
}

// Keyset 是否走游标模式。
func (c Cursor) Keyset() bool { return strings.TrimSpace(c.Col) != "" }

// Reader 源库读取器：列名以数据字典为准（解决 Oracle 大小写），值一律绑定参数。
type Reader struct {
	db   *sql.DB
	d    dialect
	ep   Endpoint
	meta *tableMeta

	// fields 映射声明的源字段名（回显用，顺序 = 读取列顺序）
	fields []string
	// mappings 实际生效的映射（空映射兜底后）
	mappings []FieldMapping
	// cols 与 fields 一一对应的真实列名（拼 SQL 用）
	cols []string
	// infos 与 cols 一一对应的列信息（类型等）
	infos []columnInfo
	// pkCols 映射里 primaryKey=true 的源列（真实大小写，保持顺序）
	pkCols []string
}

// NewReader 解析源表元数据并构造读取器。
// mappings 的 sourceField 必须在源表存在（大小写无关匹配）：让「列名写错」在启动阶段
// 就暴露，而不是跑到第 N 批才发现。mappings 为空时按源表全部列做同名镜像
// （数据管道的「只做搬运」语义，契约第 1.7 节），最终生效的映射由 Mappings() 回读。
func (c *Connector) NewReader(ctx context.Context, mappings []FieldMapping) (*Reader, error) {
	if c == nil || c.source == nil {
		return nil, fmt.Errorf("dbio: 源库未连接")
	}
	d := c.sourceDIA
	meta, err := loadMeta(ctx, c.source, d, c.sourceEP)
	if err != nil {
		return nil, err
	}
	if len(mappings) == 0 {
		mappings = mirrorMappings(meta)
	}
	fields := make([]string, 0, len(mappings))
	for _, m := range mappings {
		f := strings.TrimSpace(m.SourceField)
		if f == "" {
			return nil, fmt.Errorf("dbio: fieldMappings[].sourceField 必填")
		}
		fields = append(fields, f)
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("dbio: fieldMappings 不能为空")
	}

	r := &Reader{
		db: c.source, d: d, ep: c.sourceEP, meta: meta,
		fields: fields, mappings: mappings,
	}
	cols := make([]string, 0, len(fields))
	for _, f := range fields {
		info, ok := meta.lookup(f)
		if !ok {
			return nil, fmt.Errorf("dbio: 源表 %s.%s 不存在列 %s", r.ep.schemaOf(), r.ep.tableOnly(), f)
		}
		cols = append(cols, info.name)
		r.infos = append(r.infos, info)
	}
	r.cols = cols
	for i, m := range mappings {
		if m.PrimaryKey {
			r.pkCols = append(r.pkCols, cols[i])
		}
	}
	return r, nil
}

// mirrorMappings 用源表全部列生成同名同序映射，主键标记取数据字典的约束。
func mirrorMappings(meta *tableMeta) []FieldMapping {
	pk := func(name string) bool { return containsFold(meta.pkCols, name) }
	out := make([]FieldMapping, 0, len(meta.cols))
	for _, col := range meta.cols {
		out = append(out, FieldMapping{SourceField: col.name, TargetField: col.name, PrimaryKey: pk(col.name)})
	}
	return out
}

// Mappings 实际生效的字段映射（含空映射兜底后的结果）。
func (r *Reader) Mappings() []FieldMapping { return append([]FieldMapping(nil), r.mappings...) }

// SourceFields 映射声明的源字段名（顺序 = 读取列顺序）。
func (r *Reader) SourceFields() []string { return append([]string(nil), r.fields...) }

// PrimaryKeyFields 源端主键列（数据字典真实大小写）。
func (r *Reader) PrimaryKeyFields() []string { return append([]string(nil), r.pkCols...) }

// OrderByFields 全量分页排序列：有主键按主键；否则退化为按首个读取列
// （没有稳定排序时 OFFSET 翻页可能漏行/重行，至少保证单批内有序）。
func (r *Reader) OrderByFields() []string {
	if len(r.pkCols) > 0 {
		return r.PrimaryKeyFields()
	}
	if len(r.cols) > 0 {
		return []string{r.cols[0]}
	}
	return nil
}

// ColumnKind 列的粗粒度类型，用于把 offsetStart / cdcPosition 字符串还原成绑定值。
func (r *Reader) ColumnKind(name string) (ValueKind, bool) {
	if info, ok := r.lookup(name); ok {
		return info.kind, true
	}
	return KindText, false
}

// ResolveColumn 把「映射字段名或字典列名」解析成数据字典真实列名。
func (r *Reader) ResolveColumn(name string) (string, error) {
	if info, ok := r.lookup(name); ok {
		return info.name, nil
	}
	return "", fmt.Errorf("dbio: 列 %s 在源表 %s.%s 上不存在（可读列: %s）",
		name, r.ep.schemaOf(), r.ep.tableOnly(), strings.Join(r.cols, ","))
}

// lookup 先按映射字段名（大小写无关）匹配，再按数据字典列名匹配。
func (r *Reader) lookup(name string) (columnInfo, bool) {
	want := strings.ToUpper(strings.TrimSpace(name))
	for i, f := range r.fields {
		if strings.ToUpper(f) == want {
			return r.infos[i], true
		}
	}
	info, ok := r.meta.lookup(want)
	return info, ok
}

// TableColumns 已解析的读取列（数据字典真实大小写，顺序 = 映射顺序）。
func (r *Reader) TableColumns() []string { return append([]string(nil), r.cols...) }

// DictionaryPrimaryKeys 源表在数据字典里声明的主键列（可能为空：无主键表 / 无权看约束）。
func (r *Reader) DictionaryPrimaryKeys() []string {
	return append([]string(nil), r.meta.pkCols...)
}

// Count 源表总行数（全量模式定 totalRows）。
func (r *Reader) Count(ctx context.Context) (int64, error) {
	var total int64
	if err := r.db.QueryRowContext(ctx, r.d.countSQL(r.ep)).Scan(&total); err != nil {
		return 0, r.wrap(err, "统计源表行数失败")
	}
	return total, nil
}

// CountAfter 游标之后的待同步行数（增量模式给 progress 提供分母）。
func (r *Reader) CountAfter(ctx context.Context, col string, after any) (int64, error) {
	real, err := r.ResolveColumn(col)
	if err != nil {
		return 0, err
	}
	query, args := r.d.countAfterSQL(r.ep, real, after)
	var total int64
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&total); err != nil {
		return 0, r.wrap(err, "统计待同步行数失败")
	}
	return total, nil
}

// FetchBatch 按游标读一批。
// 返回值：行数据（key = 数据字典真实列名）、列序、错误；读到末尾返回空切片而非 error。
func (r *Reader) FetchBatch(ctx context.Context, cur Cursor, limit int) ([]map[string]any, []string, error) {
	if limit <= 0 {
		return nil, nil, fmt.Errorf("dbio: batchSize 必须大于 0，当前为 %d", limit)
	}
	var (
		query string
		args  []any
	)
	if cur.Keyset() {
		col, err := r.ResolveColumn(cur.Col)
		if err != nil {
			return nil, nil, err
		}
		query, args = r.d.keysetSQL(r.ep, r.cols, col, cur.After, limit)
	} else {
		orderBy, err := r.resolveColumns(cur.OrderBy)
		if err != nil {
			return nil, nil, err
		}
		if len(orderBy) == 0 {
			orderBy = r.OrderByFields()
		}
		query, args = r.d.pageSQL(r.ep, r.cols, orderBy, limit, cur.Offset)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, r.wrap(err, "读取源库失败")
	}
	defer func() { _ = rows.Close() }()

	out, cols, err := scanAll(rows)
	if err != nil {
		return nil, nil, r.wrap(err, "读取源库失败")
	}
	return out, cols, nil
}

// resolveColumns 批量解析列名（任一列不存在即报错，避免静默丢掉排序列导致翻页漂移）。
func (r *Reader) resolveColumns(names []string) ([]string, error) {
	out := make([]string, 0, len(names))
	for _, n := range names {
		col, err := r.ResolveColumn(n)
		if err != nil {
			return nil, err
		}
		out = append(out, col)
	}
	return out, nil
}

// ServerTime 源库服务器当前时间：cdc 模式未给起始位点时用它兜底，
// 避免引擎与库时区不一致导致首轮漏捕。
func (r *Reader) ServerTime(ctx context.Context) (time.Time, error) {
	var t time.Time
	if err := r.db.QueryRowContext(ctx, r.d.serverTimeSQL()).Scan(&t); err != nil {
		return time.Time{}, r.wrap(err, "读取源库服务器时间失败")
	}
	return t, nil
}

// Statement 包装错误消息（去掉口令）后返回，供 runner 直接进回报与日志。
func (r *Reader) Statement() string { return r.ep.Label() }

func (r *Reader) wrap(err error, action string) error {
	if err == nil {
		return nil
	}
	if cancelled := wrapCtx(err); cancelled != nil {
		return cancelled
	}
	return fmt.Errorf("dbio: %s(%s): %s", action, r.ep.Label(), redact(err.Error(), r.ep.Password))
}

// columnInfo 数据字典里的一列。
type columnInfo struct {
	name string
	kind ValueKind
}

// tableMeta 表的数据字典快照：列（字典顺序）+ 主键列 + 大小写无关索引。
type tableMeta struct {
	cols    []columnInfo
	byUpper map[string]columnInfo
	pkCols  []string
}

func (m *tableMeta) lookup(name string) (columnInfo, bool) {
	info, ok := m.byUpper[strings.ToUpper(strings.TrimSpace(name))]
	return info, ok
}

func (m *tableMeta) names() []string {
	out := make([]string, 0, len(m.cols))
	for _, c := range m.cols {
		out = append(out, c.name)
	}
	return out
}

// loadMeta 读表的全部列与主键列。表名/库名/owner 全部绑定传参。
func loadMeta(ctx context.Context, db *sql.DB, d dialect, ep Endpoint) (*tableMeta, error) {
	metaCtx, cancel := withTimeout(ctx, 10*time.Second)
	defer cancel()

	meta := &tableMeta{byUpper: make(map[string]columnInfo)}
	query, args := d.columnMetaSQL(ep)
	if err := scanColumnMeta(metaCtx, db, query, args, ep, meta); err != nil {
		return nil, err
	}
	if len(meta.cols) == 0 {
		return nil, fmt.Errorf("dbio: 表 %s.%s 不存在或当前账号看不到它的列（%s）",
			ep.schemaOf(), ep.tableOnly(), ep.Label())
	}
	pkQuery, pkArgs := d.primaryKeyMetaSQL(ep)
	if err := scanPrimaryKeys(metaCtx, db, pkQuery, pkArgs, ep, meta); err != nil {
		// 主键信息只影响排序稳定性与 upsert 匹配，取不到时降级为无主键继续
		return meta, nil //nolint:nilerr // 明确降级：主键探测失败不阻断同步
	}
	return meta, nil
}

func scanColumnMeta(ctx context.Context, db *sql.DB, query string, args []any, ep Endpoint, meta *tableMeta) error {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("dbio: 查询 %s 列信息失败: %s", ep.Label(), redact(err.Error(), ep.Password))
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			return fmt.Errorf("dbio: 解析 %s 列信息失败: %s", ep.Label(), redact(err.Error(), ep.Password))
		}
		info := columnInfo{name: name, kind: kindOf(ep.DBType(), typ)}
		meta.cols = append(meta.cols, info)
		meta.byUpper[strings.ToUpper(info.name)] = info
	}
	return rows.Err()
}

func scanPrimaryKeys(ctx context.Context, db *sql.DB, query string, args []any, ep Endpoint, meta *tableMeta) error {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("dbio: 查询 %s 主键信息失败: %s", ep.Label(), redact(err.Error(), ep.Password))
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("dbio: 解析 %s 主键信息失败: %s", ep.Label(), redact(err.Error(), ep.Password))
		}
		if info, ok := meta.lookup(name); ok {
			meta.pkCols = append(meta.pkCols, info.name)
		}
	}
	return rows.Err()
}

// kindOf 把方言原生类型归成三类，供「位点字符串 <-> 绑定值」互转使用。
func kindOf(dbType, dataType string) ValueKind {
	t := strings.ToUpper(strings.TrimSpace(dataType))
	if dbType == TypeOracle {
		switch {
		case strings.HasPrefix(t, "TIMESTAMP"), t == "DATE":
			return KindTime
		case t == "NUMBER", t == "FLOAT", t == "INTEGER", t == "DECIMAL", t == "NUMERIC",
			t == "SMALLINT", t == "DOUBLE PRECISION", t == "REAL",
			strings.HasPrefix(t, "BINARY_FLOAT"), strings.HasPrefix(t, "BINARY_DOUBLE"),
			strings.Contains(t, "INT"):
			return KindNumber
		default:
			return KindText
		}
	}
	switch t {
	case "DATE", "DATETIME", "TIMESTAMP", "TIME", "YEAR":
		return KindTime
	case "INT", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT",
		"DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "BIT":
		return KindNumber
	default:
		return KindText
	}
}
