/**
 * 指标域仓储（MySQL 实现，契约 1.12）。与内存版同名同返回结构（Promise）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'code'];

const store = defineStore({
  table: 'databridge_metric_domain',
  idPrefix: 'dom-',
  startId: 11000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'sort:asc',
  columns: {
    id: {},
    name: {},
    code: {},
    parentId: {},
    tablePrefix: {},
    owner: {},
    sort: { type: 'int' },
    delFlag: { type: 'bool' },
    remark: { type: 'text' },
    createBy: {},
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'sort:asc',
  });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const create = async (data) => {
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
    id: data.id || (await store.nextId()),
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

const count = () => store.count();

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
