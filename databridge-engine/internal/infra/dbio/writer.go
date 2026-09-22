package dbio

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// Writer 目标库写入器。
//
// 行数据的 key 是源端数据字典列名（Reader 的输出），写库前按 fieldMappings 投影成目标列顺序，
// 匹配时大小写无关，值全部走绑定参数。
type Writer struct {
	db   *sql.DB
	d    dialect
	ep   Endpoint
	meta *tableMeta

	// cols 目标表真实列名（与 mappings 同序）
	cols []string
	// srcKeys 与 cols 同序的源字段名（取值用）
	srcKeys []string
	// pkCols 映射里 primaryKey=true 的目标列（真实大小写）
	pkCols []string
}

// NewWriter 解析目标表元数据并构造写入器（映射列在目标表不存在时即刻报错）。
func (c *Connector) NewWriter(ctx context.Context, mappings []FieldMapping) (*Writer, error) {
	if c == nil || c.target == nil {
		return nil, fmt.Errorf("dbio: 目标库未连接")
	}
	if len(mappings) == 0 {
		return nil, fmt.Errorf("dbio: fieldMappings 不能为空")
	}
	d := c.targetDIA
	meta, err := loadMeta(ctx, c.target, d, c.targetEP)
	if err != nil {
		return nil, fmt.Errorf("目标库: %w", err)
	}

	w := &Writer{db: c.target, d: d, ep: c.targetEP, meta: meta}
	for _, m := range mappings {
		target := strings.TrimSpace(m.TargetField)
		if target == "" {
			target = strings.TrimSpace(m.SourceField)
		}
		if target == "" {
			return nil, fmt.Errorf("dbio: fieldMappings[].targetField 必填（sourceField=%s）", m.SourceField)
		}
		info, ok := meta.lookup(target)
		if !ok {
			return nil, fmt.Errorf("dbio: 目标表 %s.%s 不存在列 %s", w.ep.schemaOf(), w.ep.tableOnly(), target)
		}
		w.cols = append(w.cols, info.name)
		w.srcKeys = append(w.srcKeys, strings.TrimSpace(m.SourceField))
		if m.PrimaryKey {
			w.pkCols = append(w.pkCols, info.name)
		}
	}
	return w, nil
}

// TargetColumns 目标表真实列名（顺序 = 映射顺序）。
func (w *Writer) TargetColumns() []string { return append([]string(nil), w.cols...) }

// PrimaryKeyColumns 映射里标了主键的目标列。
func (w *Writer) PrimaryKeyColumns() []string { return append([]string(nil), w.pkCols...) }

// Statement 日志安全标识（不含口令）。
func (w *Writer) Statement() string { return w.ep.Label() }

// EnsureWritable 落库前置检查：
//  1. 用「只取列不取行」的探测语句验证目标表与全部映射列存在（错误暴露得更早、更明确）；
//  2. writeMode=overwrite 时先清空目标表（mysql TRUNCATE / oracle DELETE FROM）。
func (w *Writer) EnsureWritable(ctx context.Context, writeMode string) error {
	rows, err := w.db.QueryContext(ctx, w.d.probeSQL(w.ep, w.cols))
	if err != nil {
		return w.wrap(err, "目标表校验失败")
	}
	_ = rows.Close()

	if NormalizeWriteMode(writeMode) != WriteModeOverwrite {
		return nil
	}
	clear := w.d.clearSQL(w.ep)
	if w.d.multiRow() {
		// mysql: TRUNCATE 是 DDL（隐式提交），单条执行即可
		if _, err := w.db.ExecContext(ctx, clear); err != nil {
			return w.wrap(err, "清空目标表失败(TRUNCATE)")
		}
		return nil
	}
	// oracle: DELETE FROM 走事务，与后续批插同生共死
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return w.wrap(err, "清空目标表失败")
	}
	if _, err := tx.ExecContext(ctx, clear); err != nil {
		_ = tx.Rollback()
		return w.wrap(err, "清空目标表失败(DELETE)")
	}
	if err := tx.Commit(); err != nil {
		return w.wrap(err, "清空目标表提交失败")
	}
	return nil
}

// WriteBatch 写入一批并返回落库行数（一批一个事务：要么全成功提交，要么整批回滚）。
//
// writeMode: insert / upsert / overwrite（overwrite 的清表已在 EnsureWritable 完成，落库同 insert）。
// pkCols:    upsert 的匹配列（目标端列名，大小写无关）；为空时回落到 fieldMappings[].primaryKey。
func (w *Writer) WriteBatch(ctx context.Context, rows []map[string]any, writeMode string, pkCols []string) (int64, error) {
	mode := NormalizeWriteMode(writeMode)
	if len(rows) == 0 {
		return 0, nil
	}
	switch mode {
	case WriteModeInsert, WriteModeOverwrite, WriteModeUpsert:
	default:
		return 0, fmt.Errorf("dbio: 不支持的 writeMode %q（insert|upsert|overwrite）", writeMode)
	}
	pk := w.resolvePK(pkCols)
	if mode == WriteModeUpsert && len(pk) == 0 {
		return 0, fmt.Errorf("dbio: upsert 需要至少一个 primaryKey 映射列")
	}

	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, w.wrap(err, "开启写事务失败")
	}
	var written int64
	if mode == WriteModeUpsert {
		written, err = w.execUpsert(ctx, tx, rows, pk)
	} else {
		written, err = w.execInsert(ctx, tx, rows)
	}
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, w.wrap(err, "提交写事务失败")
	}
	return written, nil
}

// execInsert 批量插入：mysql 一条多值 INSERT（按绑定参数上限分片），oracle 事务内逐条执行。
func (w *Writer) execInsert(ctx context.Context, tx *sql.Tx, rows []map[string]any) (int64, error) {
	if !w.d.multiRow() {
		return w.execPerRow(ctx, tx, w.d.insertSQL(w.ep, w.cols, 1), rows, "", nil)
	}
	var written int64
	for _, chunk := range chunkRows(rows, w.d.maxRowPerStatement(len(w.cols))) {
		if _, err := tx.ExecContext(ctx, w.d.insertSQL(w.ep, w.cols, len(chunk)), w.flatArgs(chunk)...); err != nil {
			return written, w.wrap(err, "批量写入目标库失败")
		}
		written += int64(len(chunk))
	}
	return written, nil
}

// execUpsert 冲突更新：
//   - mysql：多值 INSERT ... ON DUPLICATE KEY UPDATE（命中唯一键的行由服务端就地更新）；
//   - oracle：单行 MERGE INTO ... USING (SELECT :n AS "COL" … FROM DUAL)；
//     若映射列全部是主键（MERGE 无可更新列会触发 ORA-38104）则退化为同事务 DELETE + INSERT。
func (w *Writer) execUpsert(ctx context.Context, tx *sql.Tx, rows []map[string]any, pkCols []string) (int64, error) {
	if w.d.multiRow() {
		var written int64
		for _, chunk := range chunkRows(rows, w.d.maxRowPerStatement(len(w.cols))) {
			if _, err := tx.ExecContext(ctx, w.d.upsertSQL(w.ep, w.cols, pkCols, len(chunk)), w.flatArgs(chunk)...); err != nil {
				return written, w.wrap(err, "upsert 写入目标库失败")
			}
			// MySQL 对「更新到的行」返回 2× affected，语义上仍是 1 行落库，故按提交行数计
			written += int64(len(chunk))
		}
		return written, nil
	}
	if len(pkCols) >= len(w.cols) {
		deleteSQL, insertSQL := w.d.upsertFallbackSQL(w.ep, w.cols, pkCols)
		return w.execPerRow(ctx, tx, insertSQL, rows, deleteSQL, pkCols)
	}
	return w.execPerRow(ctx, tx, w.d.upsertSQL(w.ep, w.cols, pkCols, 1), rows, "", nil)
}

// execPerRow 预处理一条语句后在同一事务里逐行执行；
// 同时给出 deleteSQL + pkCols 时，先按主键删旧行再插新行（oracle 全主键表 upsert 退化路径）。
func (w *Writer) execPerRow(ctx context.Context, tx *sql.Tx, query string, rows []map[string]any,
	deleteSQL string, pkCols []string) (int64, error) {

	stmt, err := tx.PrepareContext(ctx, query)
	if err != nil {
		return 0, w.wrap(err, "预处理写入语句失败")
	}
	defer func() { _ = stmt.Close() }()

	var del *sql.Stmt
	var pkIdx []int
	if deleteSQL != "" {
		if pkIdx, err = w.indexOfColumns(pkCols); err != nil {
			return 0, err
		}
		if del, err = tx.PrepareContext(ctx, deleteSQL); err != nil {
			return 0, w.wrap(err, "预处理删除语句失败")
		}
		defer func() { _ = del.Close() }()
	}

	var written int64
	for i := range rows {
		args := w.rowArgs(rows[i])
		if del != nil {
			pkArgs := make([]any, 0, len(pkIdx))
			for _, idx := range pkIdx {
				pkArgs = append(pkArgs, args[idx])
			}
			if _, err := del.ExecContext(ctx, pkArgs...); err != nil {
				return written, w.wrap(err, "upsert 覆盖旧行失败")
			}
		}
		if _, err := stmt.ExecContext(ctx, args...); err != nil {
			return written, w.wrap(err, "写入目标库失败")
		}
		written++
	}
	return written, nil
}

// indexOfColumns 目标列名 -> 在 w.cols 中的下标（大小写无关）。
func (w *Writer) indexOfColumns(names []string) ([]int, error) {
	out := make([]int, 0, len(names))
	for _, n := range names {
		found := -1
		for i, c := range w.cols {
			if strings.EqualFold(c, n) {
				found = i
				break
			}
		}
		if found < 0 {
			return nil, fmt.Errorf("dbio: 主键列 %s 不在目标表 %s 的映射列内", n, w.ep.tableOnly())
		}
		out = append(out, found)
	}
	return out, nil
}

// resolvePK 目标端主键列：优先用调用方传入的（大小写无关对齐到字典写法），
// 为空时回落到构造期从 fieldMappings 解析出的主键列。
func (w *Writer) resolvePK(pkCols []string) []string {
	if len(pkCols) == 0 {
		return w.PrimaryKeyColumns()
	}
	out := make([]string, 0, len(pkCols))
	for _, c := range pkCols {
		name := strings.TrimSpace(c)
		if info, ok := w.meta.lookup(name); ok {
			out = append(out, info.name)
			continue
		}
		out = append(out, name)
	}
	return out
}

// flatArgs 把多行摊平成绑定参数序列（顺序与多值 INSERT 的占位符一致）。
func (w *Writer) flatArgs(rows []map[string]any) []any {
	args := make([]any, 0, len(rows)*len(w.cols))
	for i := range rows {
		args = append(args, w.rowArgs(rows[i])...)
	}
	return args
}

// rowArgs 按目标列顺序从源行取值（源字段名大小写无关匹配）。
func (w *Writer) rowArgs(row map[string]any) []any {
	args := make([]any, 0, len(w.cols))
	var lower map[string]any
	for _, key := range w.srcKeys {
		if v, ok := row[key]; ok {
			args = append(args, v)
			continue
		}
		if lower == nil {
			lower = make(map[string]any, len(row))
			for k, v := range row {
				lower[strings.ToUpper(k)] = v
			}
		}
		args = append(args, lower[strings.ToUpper(strings.TrimSpace(key))])
	}
	return args
}

func (w *Writer) wrap(err error, action string) error {
	if err == nil {
		return nil
	}
	if cancelled := wrapCtx(err); cancelled != nil {
		return cancelled
	}
	return fmt.Errorf("dbio: %s(%s): %s", action, w.ep.Label(), redact(err.Error(), w.ep.Password))
}

// NormalizeWriteMode 归一化冲突策略：空值按 insert（契约默认）。
func NormalizeWriteMode(mode string) string {
	if m := strings.ToLower(strings.TrimSpace(mode)); m != "" {
		return m
	}
	return WriteModeInsert
}

// chunkRows 按单语句最大行数切片（受绑定参数上限约束）。
func chunkRows(rows []map[string]any, maxRows int) [][]map[string]any {
	if maxRows <= 0 {
		maxRows = 1
	}
	out := make([][]map[string]any, 0, len(rows)/maxRows+1)
	for start := 0; start < len(rows); start += maxRows {
		end := start + maxRows
		if end > len(rows) {
			end = len(rows)
		}
		out = append(out, rows[start:end])
	}
	return out
}
