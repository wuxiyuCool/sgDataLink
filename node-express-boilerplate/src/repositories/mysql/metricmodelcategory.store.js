/**
 * 建模分层树「分类」仓储（MySQL 实现，契约 1.16 / V11 四期）。
 * 与内存版同名同返回结构（Promise）：分类是全局按层的实体，不隶属指标域。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'description'];

const store = defineStore({
  table: 'databridge_metric_model_category',
  idPrefix: 'mcat-',
  startId: 20000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'sort:asc',
  columns: {
    id: {},
    name: {},
    layer: {},
    description: { type: 'text' },
    sort: { type: 'int' },
    delFlag: { type: 'bool' },
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
    description: '',
    sort: 0,
    delFlag: false,
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
