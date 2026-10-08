/**
 * 示例问答仓储（内存实现，契约 1.12）：few-shot 素材 {question, m2sql, enabled}。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const store = createMemoryStore({ prefix: 'mex-', startId: 17000 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['question', 'm2sql'],
    sort: query.sort || 'createdAt:asc',
  });

const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['question', 'm2sql'],
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const create = (data) => {
  const record = { enabled: true, note: '', ...data, id: data.id || store.nextId(), createdAt: data.createdAt || nowIso() };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
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

module.exports = require('./facade').pickImpl('metricexample', memoryImpl);
