/**
 * 数据模型仓储（内存实现，契约 1.12）。
 * columns 内联存储；mysql 实现里 columns 落独立表 databridge_metric_model_column，
 * 两侧同名方法返回结构一致：详情带 columns 数组，list/page 不带。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'tableName'];

const store = createMemoryStore({ prefix: 'mdl-', startId: 12000 });

const withoutColumns = (record) => {
  if (!record) return record;
  const { columns, ...rest } = record;
  return rest;
};

const list = () => store.all().map(withoutColumns);

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
  }).map(withoutColumns);

const page = (query = {}) => {
  const result = queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort,
    page: query.page,
    size: query.size,
  });
  return { ...result, items: result.items.map(withoutColumns) };
};

const getById = (id) => store.get(id);

const replaceColumns = (id, columns = []) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, columns, updatedAt: nowIso() });
};

const create = (data) => {
  const timestamp = nowIso();
  const { columns = [], ...rest } = data;
  const record = {
    createType: 'reference',
    layer: 'DWD',
    categoryId: '',
    status: 'online',
    version: 1,
    timeColumn: '',
    tableDdl: null,
    tableStatus: 'none',
    tableMsg: '',
    tableAt: null,
    delFlag: false,
    remark: '',
    createBy: '',
    ...rest,
    columns,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.updatedAt || timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  const { columns, ...rest } = patch;
  const merged = { ...existing, ...rest, id, updatedAt: nowIso() };
  if (Array.isArray(columns)) merged.columns = columns;
  return store.replace(id, merged);
};

const deleteById = (id) => store.remove(id) || null;

const count = () => store.size();

const memoryImpl = {
  list,
  find,
  page,
  getById,
  create,
  update,
  replaceColumns,
  delete: deleteById,
  count,
  clear: store.clear,
};

module.exports = require('./facade').pickImpl('metricmodel', memoryImpl);
