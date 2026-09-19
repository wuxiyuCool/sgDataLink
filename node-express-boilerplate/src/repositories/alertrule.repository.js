/**
 * 告警规则仓储（内存实现，docs/API.md 第 1.10 节）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（alert_rule 表，conditions/channels 用 jsonb）时只改本文件。
 *
 * conditions 取值：task_failed | pipeline_error | lag_over_threshold
 * scope：all | task | dataflow | pipeline（匹配告警目标的 kind，缺省按 all 处理）
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name'];

const store = createMemoryStore({ prefix: 'ar-', startId: 9000 });

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

/** 启用中的规则，触发告警时遍历（内存阶段数量很小，直接线性扫描） */
const findEnabled = () => find({ filters: { enabled: true } });

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    scope: 'all',
    conditions: [],
    thresholdLagMs: 5000,
    channels: [],
    enabled: true,
    ...data,
    id: data.id || store.nextId(),
    createdAt: data.createdAt || timestamp,
    updatedAt: data.createdAt || timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id, updatedAt: nowIso() });
};

const deleteById = (id) => store.remove(id) || null;

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  findEnabled,
  clear: store.clear,
};
