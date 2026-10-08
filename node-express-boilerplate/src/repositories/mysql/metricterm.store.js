/**
 * 业务术语仓储（MySQL 实现，契约 1.12）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const store = defineStore({
  table: 'databridge_metric_term',
  idPrefix: 'mterm-',
  startId: 16000,
  keywordFields: ['name'],
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    name: {},
    alias: { type: 'json' },
    description: { type: 'text' },
    relatedMetricIds: { type: 'json', col: 'related_metric_ids' },
    relatedModelIds: { type: 'json', col: 'related_model_ids' },
    delFlag: { type: 'bool', col: 'del_flag' },
    createdAt: { type: 'datetime', col: 'created_at' },
    updatedAt: { type: 'datetime', col: 'updated_at' },
  },
});

const list = () => store.list();
const find = (query = {}) => store.find({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort || 'createdAt:asc' });
const page = (query = {}) => store.page({ filters: query.filters || {}, keyword: query.keyword, sort: query.sort, page: query.page, size: query.size });
const getById = (id) => store.getById(id);

const create = (data) => {
  const timestamp = nowIso();
  return store.insert({
    alias: [],
    relatedMetricIds: [],
    relatedModelIds: [],
    delFlag: false,
    ...data,
    id: data.id || undefined,
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  });
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
  count: () => store.count(),
  clear: () => store.clear(),
};
