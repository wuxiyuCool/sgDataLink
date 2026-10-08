/**
 * 清洗汇总任务仓储（内存实现，契约 1.12 §7.2）。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name'];

const store = createMemoryStore({ prefix: 'mtk-', startId: 14000 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
  });

const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    domainId: '',
    metricIds: [],
    dimensionColumnIds: [],
    cleanRules: [],
    timePreset: null,
    targetModelId: '',
    targetTable: '',
    writeMode: 'overwrite',
    upsertKeys: [],
    scheduleCron: '',
    status: 'online',
    lastStatus: 'idle',
    lastRunAt: null,
    delFlag: false,
    remark: '',
    createBy: '',
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = (id) => store.remove(id) || null;

const count = () => store.size();

const memoryImpl = { list, find, page, getById, create, update, delete: deleteById, count, clear: store.clear };

module.exports = require('./facade').pickImpl('metrictask', memoryImpl);
