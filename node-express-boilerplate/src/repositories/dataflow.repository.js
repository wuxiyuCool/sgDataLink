/**
 * 数据开发（ETL 编排画布）仓储（内存实现，docs/API.md 第 1.8 节）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（dataflow 表，nodes / edges 用 jsonb 列）时只改本文件内部逻辑。
 *
 * 与 task 的差别只有「运行体是画布」：调度字段（scheduleCron / retryCount / retryIntervalSec）
 * 与 task 完全同构，因此 services/run.service.js 把它注册成一种 runner 即可复用定时与重试。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name'];

const store = createMemoryStore({ prefix: 'df-', startId: 7500 });

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

/** 是否引用了某个数据源（任一 input/output 节点的 config.datasourceId），供 40002 校验 */
const findByDataSource = (dataSourceId) =>
  list().filter((dataflow) =>
    (dataflow.nodes || []).some((node) => node && node.config && node.config.datasourceId === dataSourceId)
  );

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    nodes: [],
    edges: [],
    scheduleCron: null,
    retryCount: 3,
    retryIntervalSec: 60,
    enabled: true,
    lastStatus: 'idle',
    lastRunAt: null,
    runningInstanceId: null,
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

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  findByDataSource,
  clear: store.clear,
};
