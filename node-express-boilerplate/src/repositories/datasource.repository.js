/**
 * 数据源仓储（内存实现）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 将本文件的 store 调用换成 PostgreSQL 实现（datasource 表 + SQL），
 * 保持 find / page / getById / create / update / delete 的签名与返回结构不变，
 * datasource.service.js 与 controller 不需要修改。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'host', 'database', 'username', 'remark'];

const store = createMemoryStore({ prefix: 'ds-', startId: 1000 });

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
  });

/** 分页查询，返回 { items, total, page, size, pages } */
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

const count = () => store.size();

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    ...data,
    id: data.id || store.nextId(),
    status: data.status || 'enabled',
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

/** 内存实现（DB_DRIVER=memory 时生效）；mysql 实现见 ./mysql/datasource.store.js */
const memoryImpl = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  clear: store.clear,
};

// 双驱动门面：DB_DRIVER=mysql 时换成同名异步实现，方法签名统一返回 Promise
module.exports = require('./facade').pickImpl('datasource', memoryImpl);
