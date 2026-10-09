/**
 * 维度取值档案服务（契约 1.14 / V11 二期）：探查目标库某维度列的真实取值，
 * 并承载「库里 01 = 业务华东」这类码值登记，供问数 prompt 与解析后值校正使用。
 *
 * 刻意不 require metricmodel.service（那会形成 model↔dim 循环依赖）：
 * 上层把已取到的模型对象传进来，本服务只认模型的数据形态。
 */
const config = require('../config/config');
const { paramInvalid } = require('../utils/bizError');
const dialect = require('../utils/dialect');
const datasourceRepository = require('../repositories/datasource.repository');
const metricDimValueRepository = require('../repositories/metricdimvalue.repository');
const metricExecService = require('./metricExec.service');
const metricSettingService = require('./metricsetting.service');

const TOP_N_DEFAULT = 50;
const TOP_N_MAX = 200;
const DISTINCT_GUARD_DEFAULT = 200;
const DISTINCT_GUARD_MAX = 5000;

const active = (items) => items.filter((item) => !item.delFlag);

const clamp = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
};

/** 探查对象默认取全部维度列：度量列的取值不是"可过滤的维度"，时间列走日期条件不进词典 */
const dimensionColumns = (model, requested) => {
  const columns = (model.columns || []).filter((column) => column.role === 'dimension');
  if (!requested || !requested.length) return columns;
  const wanted = new Set(requested.map((name) => String(name)));
  const picked = columns.filter((column) => wanted.has(String(column.columnName)));
  const missing = [...wanted].filter((name) => !picked.some((column) => String(column.columnName) === name));
  if (missing.length) {
    throw paramInvalid(`以下列不是该模型的维度列（度量/时间列或不存在的列不参与取值探查）: ${missing.join('、')}`);
  }
  return picked;
};

const shapeRow = (row) => ({
  value: String(row.value),
  label: row.label || '',
  hits: Number(row.hits || 0),
  source: row.source || 'auto',
  stale: row.stale === true,
  profiledAt: row.profiledAt || null,
});

/**
 * POST /metric-models/:id/profile-dimensions
 * 每列两步：① COUNT(DISTINCT) 基数预检（超阈值直接跳过取值，既不压库也不把用户ID灌进 prompt）
 * ② GROUP BY 取 topN。SQL 全部出自方言层，MySQL 用 LIMIT、Oracle 用 ROWNUM 嵌套。
 */
const profileModel = async (model, body = {}) => {
  if (config.db.driver !== 'mysql') throw paramInvalid('取值探查需要 DB_DRIVER=mysql 真实执行（内存模式不发起真实查询）');
  const columns = dimensionColumns(model, body.columns);
  if (!columns.length) throw paramInvalid('该模型没有维度列，没有可探查的取值');
  const topN = clamp(body.topN, 1, TOP_N_MAX, TOP_N_DEFAULT);
  const guard = clamp(body.distinctGuard, 1, DISTINCT_GUARD_MAX, DISTINCT_GUARD_DEFAULT);
  const ds = await datasourceRepository.getById(model.datasourceId);
  if (!ds || ds.status === 'disabled') throw paramInvalid(`数据源不可用: ${model.datasourceId}`);
  const dl = dialect.dialectOfSource(ds);
  const table = model.tableName;
  const profiledAt = new Date().toISOString();

  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const column of columns) {
    const name = String(column.columnName);
    // eslint-disable-next-line no-await-in-loop
    const counted = await metricExecService.runSql(ds.id, dl.dimCountSql({ table, column: name }), { limit: 10 });
    const distinctCount = Number(((counted.rows || [])[0] || [])[0] || 0);
    if (distinctCount > guard) {
      // 高基数列：不取值、也不清掉旧档案（可能是上次人工登记的码值）
      results.push({ columnName: name, highCardinality: true, distinctCount, values: [] });
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fetched = await metricExecService.runSql(ds.id, dl.dimProfileSql({ table, column: name, limit: topN }), {
      limit: topN,
    });
    const values = (fetched.rows || []).map((row) => ({ value: row[0], hits: Number(row[1] || 0) }));
    // eslint-disable-next-line no-await-in-loop
    const stored = await metricDimValueRepository.replaceColumnValues(model.id, name, values, profiledAt);
    results.push({
      columnName: name,
      bizName: column.bizName || name,
      highCardinality: false,
      distinctCount,
      values: stored.filter((row) => String(row.columnName) === name).map(shapeRow),
    });
  }
  return { modelId: model.id, dialect: dl.type, table, topN, distinctGuard: guard, profiledAt, columns: results };
};

/** GET /metric-models/:id/dimension-values —— 只读档案（界面/下拉用，绝不打源库） */
const listValues = async (model, query = {}) => {
  const rows = active(await metricDimValueRepository.listByModel(model.id));
  const columnName = query.columnName ? String(query.columnName) : '';
  const keyword = String(query.keyword || '')
    .trim()
    .toLowerCase();
  const filtered = rows
    .filter((row) => !columnName || String(row.columnName) === columnName)
    .filter((row) => {
      if (!keyword) return true;
      return `${row.value} ${row.label}`.toLowerCase().includes(keyword);
    });
  const grouped = new Map();
  filtered.forEach((row) => {
    if (!grouped.has(row.columnName)) grouped.set(row.columnName, []);
    grouped.get(row.columnName).push(shapeRow(row));
  });
  return {
    modelId: model.id,
    columns: [...grouped.entries()].map(([name, values]) => ({ columnName: name, values })),
    total: filtered.length,
  };
};

/** PUT —— 登记业务名（01=华东）；label 传空串＝取消登记 */
const saveLabels = async (model, body = {}) => {
  const columnName = String(body.columnName || '');
  if (!columnName) throw paramInvalid('columnName 必填');
  if (!(model.columns || []).some((column) => String(column.columnName) === columnName)) {
    throw paramInvalid(`列不在模型字段清单中: ${columnName}`);
  }
  const entries = Array.isArray(body.values) ? body.values : [];
  if (!entries.length) throw paramInvalid('values 不能为空');
  if (entries.length > TOP_N_MAX) throw paramInvalid(`单次最多登记 ${TOP_N_MAX} 个取值`);
  const cleaned = entries.map((entry) => {
    const value = String(entry.value === undefined || entry.value === null ? '' : entry.value);
    if (!value.trim()) throw paramInvalid('values[].value 不能为空');
    return { value: value.slice(0, 191), label: String(entry.label || '').slice(0, 191) };
  });
  const stored = await metricDimValueRepository.saveLabels(model.id, columnName, cleaned);
  return {
    modelId: model.id,
    columnName,
    values: stored.filter((row) => String(row.columnName) === columnName).map(shapeRow),
  };
};

const clearColumn = async (model, columnName) => {
  if (!columnName) throw paramInvalid('columnName 必填');
  await metricDimValueRepository.removeColumn(model.id, String(columnName));
  return { modelId: model.id, columnName, cleared: true };
};

/** 问数侧唯一入口：某模型的「列 → 取值」映射（含人工 label），供 prompt 与值校正共用 */
const valuesByModel = async (modelId) => {
  const rows = active(await metricDimValueRepository.listByModel(modelId));
  const byColumn = new Map();
  rows.forEach((row) => {
    if (row.stale === true) return; // 库里已消失的旧值不再作为候选（历史 label 仍留在档案里）
    if (!byColumn.has(row.columnName)) byColumn.set(row.columnName, []);
    byColumn.get(row.columnName).push({ value: String(row.value), label: row.label || '', hits: Number(row.hits || 0) });
  });
  return byColumn;
};

/** 一次取全部模型的档案（问数索引重建时调用，避免按模型 N 次查询） */
const valuesByModelId = async () => {
  const rows = active(await metricDimValueRepository.list());
  const grouped = new Map();
  rows.forEach((row) => {
    if (row.stale === true) return;
    const key = `${row.modelId}.${row.columnName}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ value: String(row.value), label: row.label || '', hits: Number(row.hits || 0) });
  });
  return grouped;
};

/** 一次读配置拿到问数侧两项（默认关：候选值是真实业务数据，进 prompt 即出境） */
const promptConfig = async () => metricSettingService.getChatConfig();

module.exports = {
  profileModel,
  listValues,
  saveLabels,
  clearColumn,
  valuesByModel,
  valuesByModelId,
  promptConfig,
  dimensionColumns,
  TOP_N_MAX,
  DISTINCT_GUARD_MAX,
};
