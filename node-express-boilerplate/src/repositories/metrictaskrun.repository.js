/**
 * 指标任务执行记录仓储（内存实现，契约 1.12）。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const store = createMemoryStore({ prefix: 'mtr-', startId: 14900 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['taskId'],
    sort: query.sort || 'createdAt:desc',
  });

const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: ['taskId'],
    sort: query.sort || 'createdAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const create = (data) => {
  const record = {
    trigger: 'manual',
    status: 'running',
    readRows: 0,
    writeRows: 0,
    elapsedMs: 0,
    message: null,
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || nowIso(),
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = (id) => store.remove(id) || null;

const count = () => store.size();

const memoryImpl = { list, find, page, getById, create, update, delete: deleteById, count, clear: store.clear };

module.exports = require('./facade').pickImpl('metrictaskrun', memoryImpl);
