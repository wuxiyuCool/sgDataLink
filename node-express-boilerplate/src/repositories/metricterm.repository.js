/**
 * 业务术语仓储（内存实现，契约 1.12）：LLM 侧知识，name/alias/description + 关联指标/模型。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const store = createMemoryStore({ prefix: 'mterm-', startId: 16000 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['name', 'description'],
    sort: query.sort || 'createdAt:asc',
  });

const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['name', 'description'],
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    alias: [],
    relatedMetricIds: [],
    relatedModelIds: [],
    delFlag: false,
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

const memoryImpl = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: (id) => store.remove(id) || null,
  count: () => store.size(),
  clear: store.clear,
};

module.exports = require('./facade').pickImpl('metricterm', memoryImpl);
