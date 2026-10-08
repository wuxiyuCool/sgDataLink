/**
 * 指标仓储（MySQL 实现，契约 1.12）。M1 底座 CRUD；依赖边/版本在 M2 service 层补。
 * keyword 搜 alias：JSON 列 LIKE 对序列化文本生效（含中文别名）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['name', 'code', 'alias'];

const store = defineStore({
  table: 'databridge_metric_metric',
  idPrefix: 'met-',
  startId: 13000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'createdAt:asc',
  columns: {
    id: {},
    code: {},
    name: {},
    alias: { type: 'json' },
    type: {},
    defineType: {},
    modelId: {},
    domainId: {},
    expr: { type: 'text' },
    defineParams: { type: 'json', col: 'define_params' },
    unit: {},
    dataFormat: { col: 'data_format' },
    caliber: { type: 'text' },
    owner: {},
    status: {},
    version: { type: 'int' },
    isPublish: { type: 'bool', col: 'is_publish' },
    delFlag: { type: 'bool', col: 'del_flag' },
    remark: { type: 'text' },
    createBy: { col: 'create_by' },
    createdAt: { type: 'datetime', col: 'created_at' },
    updatedAt: { type: 'datetime', col: 'updated_at' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'createdAt:asc',
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
    type: 'ATOMIC',
    defineType: 'MEASURE',
    modelId: '',
    domainId: '',
    alias: [],
    unit: '',
    dataFormat: 'DECIMAL',
    caliber: '',
    owner: '',
    status: 'draft',
    version: 1,
    isPublish: false,
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
