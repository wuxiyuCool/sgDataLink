/**
 * 数据管道（CDC）仓储（内存实现，docs/API.md 第 1.7 节）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（cdc_pipeline 表）时只改本文件内部逻辑，
 * find / page / getById / create / update / delete 签名保持不变。
 *
 * 注意 changeRows / currentQps / lagMs / cdcPosition / startedAt 是「运行态」字段：
 * 由 Go 引擎每次 tick 的 /engine/report（带 pipelineId）刷新，
 * GET /pipelines/:id/status 直接读它们，第二阶段换成 pipeline 状态表 + 位点表。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'sourceId', 'targetId'];

const store = createMemoryStore({ prefix: 'pipe-', startId: 7000 });

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

/** 是否引用了某个数据源（源端或目标端），供数据源删除的 40002 校验复用 */
const findByDataSource = (dataSourceId) =>
  list().filter((item) => item.sourceId === dataSourceId || item.targetId === dataSourceId);

const findRunning = () => find({ filters: { status: 'running' } });

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    ddlPolicy: 'ignore',
    status: 'stopped',
    runningInstanceId: null,
    lastError: null,
    syncObjects: [],
    batchSize: 1000,
    failureRate: 0,
    // ---- 运行态（引擎回报刷新）----
    changeRows: 0,
    currentQps: 0,
    lagMs: 0,
    cdcPosition: null,
    startedAt: null,
    lastReportAt: null,
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
  findRunning,
  clear: store.clear,
};
