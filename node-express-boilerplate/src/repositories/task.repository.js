/**
 * 同步任务仓储（内存实现）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（sync_task 表）时只改本文件内部逻辑：
 * find / page / getById / create / update / delete 的签名保持不变，
 * syncTask.service.js / datasource.service.js（引用校验）都不需要改。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['name', 'sourceTable', 'targetTable'];

const store = createMemoryStore({ prefix: 'task-', startId: 2000 });

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

/** 数据源被哪些任务引用（sourceId / targetId），用于删除时的 40002 校验 */
const findByDataSource = (dataSourceId) =>
  list().filter((task) => task.sourceId === dataSourceId || task.targetId === dataSourceId);

/** 以某状态运行的任务，用于 start/stop 的幂等判断 */
const findRunning = () => find({ filters: { lastStatus: 'running' } });

const create = (data) => {
  const timestamp = nowIso();
  const record = {
    syncMode: 'full',
    writeMode: 'insert',
    batchSize: 1000,
    incrementalColumn: null,
    fieldMappings: [],
    enabled: true,
    lastStatus: 'idle',
    lastRunAt: null,
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
