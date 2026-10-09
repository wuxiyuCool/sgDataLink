/**
 * 数据开发流水线的纯行变换器（契约 1.8.1）：pivot（行转列/列转行）与 json（格式化转换）。
 * 纯函数、无 IO，供 dataflowEngine 调用；config 非法一律 paramInvalid（40001）。
 */
const { paramInvalid } = require('../utils/bizError');

const toNum = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const AGG_FNS = {
  sum: (values) => values.reduce((acc, v) => acc + toNum(v), 0),
  count: (values) => values.length,
  avg: (values) => (values.length ? Number((values.reduce((acc, v) => acc + toNum(v), 0) / values.length).toFixed(6)) : null),
  min: (values) => {
    const filled = values.filter((v) => v !== null && v !== undefined && v !== '');
    return filled.length ? filled.reduce((acc, v) => (toNum(v) < toNum(acc) ? v : acc)) : null;
  },
  max: (values) => {
    const filled = values.filter((v) => v !== null && v !== undefined && v !== '');
    return filled.length ? filled.reduce((acc, v) => (toNum(v) > toNum(acc) ? v : acc)) : null;
  },
  first: (values) => (values.length ? values[0] : null),
};

/** 生成列名白名单化（中文保留，其余符号换下划线）：pivot 值 / json 点路径都可能带非法字符 */
const sanitizeColumn = (name) => String(name).replace(/[^A-Za-z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 64) || 'col';

const pivotToRows = (label, cfg, rows) => {
  const cols = Array.isArray(cfg.unpivotColumns) && cfg.unpivotColumns.length ? cfg.unpivotColumns : null;
  if (!cols) throw paramInvalid(`${label} mode=to_rows 需要 config.unpivotColumns`);
  const nameColumn = sanitizeColumn(cfg.nameColumn || 'NAME');
  const valueColumn = sanitizeColumn(cfg.valueColumn || 'VALUE');
  const out = [];
  rows.forEach((row) => {
    cols.forEach((col) => {
      const extra = { [nameColumn]: col };
      extra[valueColumn] = row[col] === undefined ? null : row[col];
      out.push({ ...row, ...extra });
    });
  });
  return out;
};

const pivotToColumns = (label, cfg, rows) => {
  const groupBy = Array.isArray(cfg.groupBy) && cfg.groupBy.length ? cfg.groupBy : Object.keys(rows[0] || []);
  const { pivotColumn, valueColumn } = cfg;
  if (!pivotColumn || !valueColumn) throw paramInvalid(`${label} mode=to_columns 需要 config.pivotColumn 与 valueColumn`);
  const agg = AGG_FNS[String(cfg.agg || 'sum').toLowerCase()];
  if (!agg) throw paramInvalid(`${label} agg 仅支持 ${Object.keys(AGG_FNS).join('|')}`);
  const groups = new Map();
  const columnValues = new Set(Array.isArray(cfg.columns) && cfg.columns.length ? cfg.columns : []);
  rows.forEach((row) => {
    const key = groupBy.map((col) => String(row[col])).join('|');
    if (!columnValues.size || !Array.isArray(cfg.columns) || !cfg.columns.length) {
      const pv = row[pivotColumn];
      if (pv !== null && pv !== undefined && pv !== '') columnValues.add(String(pv));
    }
    if (!groups.has(key)) {
      const base = {};
      groupBy.forEach((col) => {
        base[sanitizeColumn(col)] = row[col];
      });
      groups.set(key, { base, buckets: new Map() });
    }
    const bucket = groups.get(key);
    const pv = String(row[pivotColumn]);
    if (!bucket.buckets.has(pv)) bucket.buckets.set(pv, []);
    bucket.buckets.get(pv).push(row[valueColumn]);
  });
  const cols = Array.from(columnValues).map(String);
  const out = [];
  groups.forEach(({ base, buckets }) => {
    const rowOut = { ...base };
    cols.forEach((colName) => {
      const values = buckets.get(colName) || [];
      rowOut[sanitizeColumn(colName)] = values.length ? agg(values) : null;
    });
    out.push(rowOut);
  });
  return out;
};

const pivotRows = (node, rows) => {
  const cfg = node.config || {};
  const label = `pivot 节点 ${node.name || node.id}`;
  if (!rows.length && !cfg.columns) return [];
  if (cfg.mode === 'to_rows') return pivotToRows(label, cfg, rows);
  if (cfg.mode === 'to_columns') return pivotToColumns(label, cfg, rows);
  throw paramInvalid(`${label} mode 仅支持 to_columns|to_rows，当前: ${cfg.mode}`);
};

/* ---------------- json 节点（parse / stringify / format） ---------------- */

const getByPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((acc, key) => (acc !== null && acc !== undefined && typeof acc === 'object' ? acc[key] : undefined), obj);

const parseJsonSafe = (value) => {
  if (value === null || value === undefined) return { ok: false, value: null };
  if (typeof value === 'object') return { ok: true, value };
  const text = String(value).trim();
  if (!text) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, value: null };
  }
};

const jsonRows = (node, rows) => {
  const cfg = node.config || {};
  const label = `json 节点 ${node.name || node.id}`;
  const column = cfg.column;
  if (!column) throw paramInvalid(`${label} 需要 config.column`);
  const onError = ['null', 'skip', 'fail'].includes(cfg.onError) ? cfg.onError : 'null';
  const handleBad = (index) => {
    if (onError === 'fail') throw paramInvalid(`${label} 第 ${index + 1} 行的 ${column} 不是合法 JSON`);
    return onError === 'skip' ? 'skip' : null;
  };
  if (cfg.mode === 'stringify') {
    return rows
      .map((row) => {
        const value = row[column];
        if (value === null || value === undefined || typeof value === 'string') return row;
        return { ...row, [column]: JSON.stringify(value, null, cfg.pretty ? 2 : 0) };
      })
      .filter(Boolean);
  }
  if (cfg.mode === 'format') {
    const out = [];
    rows.forEach((row, index) => {
      const parsed = parseJsonSafe(row[column]);
      if (!parsed.ok) {
        const bad = handleBad(index);
        if (bad === 'skip') return;
        out.push({ ...row, [column]: null });
        return;
      }
      out.push({ ...row, [column]: JSON.stringify(parsed.value, null, cfg.pretty === false ? 0 : 2) });
    });
    return out;
  }
  if (cfg.mode !== 'parse') throw paramInvalid(`${label} mode 仅支持 parse|stringify|format，当前: ${cfg.mode}`);
  const keys = Array.isArray(cfg.keys) && cfg.keys.length ? cfg.keys : null;
  const out = [];
  rows.forEach((row, index) => {
    const parsed = parseJsonSafe(row[column]);
    if (!parsed.ok) {
      const bad = handleBad(index);
      if (bad === 'skip') return;
      // 坏数据置空时同样补齐抽取列（否则下游按列写入会缺键）
      const rowOut = { ...row, [column]: null };
      if (keys) keys.forEach((path) => { rowOut[sanitizeColumn(String(path))] = null; });
      out.push(rowOut);
      return;
    }
    if (!keys) {
      out.push({ ...row, [column]: parsed.value });
      return;
    }
    const extra = { ...row };
    delete extra[column];
    keys.forEach((path) => {
      const value = getByPath(parsed.value, path);
      extra[sanitizeColumn(String(path))] = value === undefined ? null : value;
    });
    out.push(extra);
  });
  return out;
};

module.exports = { pivotRows, jsonRows, sanitizeColumn, AGG_FNS };
