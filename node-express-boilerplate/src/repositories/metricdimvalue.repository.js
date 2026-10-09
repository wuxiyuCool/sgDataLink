/**
 * 维度取值档案仓储（内存实现，契约 1.14）：与 mysql store 同名同返回结构。
 * memory 模式不连真库，档案只能来自人工登记或 seed；探查接口在内存模式下会被 service 层挡掉。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const store = createMemoryStore({ prefix: 'mdv-', startId: 19000 });

const clip = (text) => String(text === undefined || text === null ? '' : text).slice(0, 191);
const byColumn = (modelId, columnName) =>
  store
    .all()
    .filter((row) => String(row.modelId) === String(modelId) && String(row.columnName) === String(columnName))
    .sort((a, b) => b.hits - a.hits || String(a.value).localeCompare(String(b.value)));

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['value', 'label'],
    sort: query.sort || 'hits:desc',
  });

const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['value', 'label'],
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const listByModel = (modelId) =>
  store
    .all()
    .filter((row) => String(row.modelId) === String(modelId))
    .sort(
      (a, b) =>
        String(a.columnName).localeCompare(String(b.columnName)) ||
        b.hits - a.hits ||
        String(a.value).localeCompare(String(b.value))
    );

const upsert = (modelId, columnName, item, { source, resetStale, touchLabel }) => {
  const existing = byColumn(modelId, columnName).find((row) => String(row.value) === String(item.value));
  const timestamp = nowIso();
  if (existing) {
    const patch = { updatedAt: timestamp };
    if (resetStale) patch.stale = false;
    if (touchLabel) patch.label = clip(item.label);
    if (source === 'auto') patch.hits = Number(item.hits || 0);
    if (item.profiledAt !== undefined) patch.profiledAt = item.profiledAt;
    return store.replace(existing.id, { ...existing, ...patch });
  }
  return store.insert({
    modelId: String(modelId),
    columnName: String(columnName),
    value: clip(item.value),
    label: clip(item.label || ''),
    hits: Number(item.hits || 0),
    source,
    stale: false,
    profiledAt: item.profiledAt || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
};

/** 探查回写：该列 auto 行先标 stale，再逐值 upsert（人工 label 优先，不被探查覆盖） */
const replaceColumnValues = (modelId, columnName, values = [], profiledAt = nowIso()) => {
  byColumn(modelId, columnName)
    .filter((row) => row.source === 'auto')
    .forEach((row) => store.replace(row.id, { ...row, stale: true, updatedAt: nowIso() }));
  values.forEach((item) =>
    upsert(modelId, columnName, { ...item, profiledAt }, { source: 'auto', resetStale: true, touchLabel: false })
  );
  return listByModel(modelId);
};

/** 人工登记业务名：档案里没有的值补录成 manual */
const saveLabels = (modelId, columnName, entries = []) => {
  entries.forEach((entry) => upsert(modelId, columnName, entry, { source: 'manual', resetStale: true, touchLabel: true }));
  return listByModel(modelId);
};

const removeColumn = (modelId, columnName) => {
  byColumn(modelId, columnName).forEach((row) => store.remove(row.id));
  return true;
};

const removeModel = (modelId) => {
  listByModel(modelId).forEach((row) => store.remove(row.id));
  return true;
};

const memoryImpl = {
  list,
  find,
  page,
  getById,
  listByModel,
  replaceColumnValues,
  saveLabels,
  removeColumn,
  removeModel,
  clear: store.clear,
};

module.exports = require('./facade').pickImpl('metricdimvalue', memoryImpl);
