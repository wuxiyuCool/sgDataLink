/**
 * 示例问答仓储（MySQL 实现，契约 1.12）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const store = defineStore({
  table: 'databridge_metric_example',
  idPrefix: 'mex-',
  startId: 17000,
  keywordFields: ['question'],
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    question: { type: 'text' },
    m2sql: { type: 'text' },
    note: { type: 'text' },
    enabled: { type: 'bool' },
    createdAt: { type: 'datetime', col: 'created_at' },
  },
});

const list = () => store.list();
const find = (query = {}) => store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'createdAt:asc' });
const page = (query = {}) => store.page({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort, page: query.page, size: query.size });
const getById = (id) => store.getById(id);

const create = (data) => {
  const record = { enabled: true, note: '', ...data, createdAt: data.createdAt || nowIso() };
  return store.insert(record);
};

const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
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
  count: () => store.count(),
  clear: () => store.clear(),
};
