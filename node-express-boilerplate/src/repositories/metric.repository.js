/**
 * 指标仓储（内存实现，契约 1.12）。M1 只提供 CRUD 底座与查询；
 * 公式解析/依赖表/版本快照在 M2 的 metric.service 层补齐。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'code', 'alias'];

const store = createMemoryStore({ prefix: 'met-', startId: 13000 });

const list = () => store.all();

const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'createdAt:asc',
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

// 关键字匹配只认字符串字段（memoryStore.matchesKeyword）：内存模式 alias 搜不中，
// mysql 模式 JSON 列 LIKE 可搜。演示态可接受，真实产品路径（mysql）功能完整。
const create = (data) => {
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

module.exports = require('./facade').pickImpl('metric', memoryImpl);
