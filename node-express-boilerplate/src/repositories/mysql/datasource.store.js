/**
 * 数据源仓储（MySQL 实现，契约 1.1）。
 *
 * 与 datasource.repository.js 的内存实现逐方法同名、返回结构一致，只是返回 Promise；
 * 列定义对齐 src/db/schema.sql 的 databridge_datasource。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'host', 'database', 'username', 'remark'];

const store = defineStore({
  table: 'databridge_datasource',
  idPrefix: 'ds-',
  startId: 1000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    type: {},
    host: {},
    port: { type: 'int' },
    database: {},
    username: {},
    password: {},
    remark: { type: 'text' },
    status: {},
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

const list = () => store.list();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:asc',
  });

/** 分页查询，返回 { items, total, page, size, pages } */
const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

const create = async (data) => {
  const timestamp = nowIso();
  const record = {
    ...data,
    id: data.id || (await store.nextId()),
    status: data.status || 'enabled',
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  clear: () => store.clear(),
};
