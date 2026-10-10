/**
 * 建模分层树「分类」仓储（内存实现，契约 1.16 / V11 四期）。
 * 分类是全局按层的实体（一个分类属于且只属于一个 layer），与指标域 domain_id 那条轴正交；
 * 树上的 5 个分层根由 services/metricmodelcategory.service.js 的 LAYERS 常量虚拟化生成，不落库。
 * 软删（delFlag），删分类时名下模型的降级动作在 service 层。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'description'];

const store = createMemoryStore({ prefix: 'mcat-', startId: 20000 });

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
    description: '',
    sort: 0,
    delFlag: false,
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

module.exports = require('./facade').pickImpl('metricmodelcategory', memoryImpl);
