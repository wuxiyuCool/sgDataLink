/**
 * 指标域仓储（内存实现，契约 1.12）。树形结构：parentId='0' 为根。
 * 软删（delFlag），删除前的资产校验在 services/metricdomain.service.js。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'code'];

const store = createMemoryStore({ prefix: 'dom-', startId: 11000 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'sort:asc',
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
    parentId: '0',
    tablePrefix: '',
    owner: '',
    sort: 0,
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

module.exports = require('./facade').pickImpl('metricdomain', memoryImpl);
