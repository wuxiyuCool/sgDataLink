/**
 * 任务运行实例仓储（内存实现）。
 *
 * 【第二阶段替换点 / Repository 模式】
 * 换成 PostgreSQL 实现（task_instance 表）时只改本文件内部逻辑；
 * find / page / getById / create / update / delete 之外，
 * 额外提供 findByTask / findLatestByTask 两个查询语义（对应 SQL 的 where + order by limit 1）。
 */
const { createMemoryStore, queryList, filterList, nowIso } = require('./memoryStore');

const KEYWORD_FIELDS = ['taskName'];

const store = createMemoryStore({ prefix: 'inst-', startId: 3000 });

const list = () => store.all();

/** 查询（不分页），query = { filters, keyword, sort } */
const find = (query = {}) =>
  filterList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'startedAt:desc',
  });

/** 分页查询，返回 { items, total, page, size, pages } */
const page = (query = {}) =>
  queryList(list(), {
    filters: query.filters || {},
    keyword: query.keyword,
    keywordFields: KEYWORD_FIELDS,
    sort: query.sort || 'startedAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.get(id);

const count = () => store.size();

/** 某任务的全部实例，按开始时间倒序 */
const findByTask = (taskId, status) =>
  find({ filters: status ? { taskId, status } : { taskId }, sort: 'startedAt:desc' });

/** 某任务最近一次实例（用于 /tasks/:id/progress 聚合视图） */
const findLatestByTask = (taskId) => findByTask(taskId)[0] || null;

/** 某任务当前 running 的实例 */
const findRunningByTask = (taskId) => findByTask(taskId, 'running')[0] || null;

const create = (data) => {
  const timestamp = data.startedAt || nowIso();
  const record = {
    progress: 0,
    totalRows: 0,
    readRows: 0,
    writeRows: 0,
    rateRowsPerSec: 0,
    status: 'running',
    // 契约 1.6：manual（人工/接口触发）| cron（调度器）| retry（失败自动重试）
    trigger: 'manual',
    /** 本实例处于第几次重试链上：0 = 首次运行，>0 = 第 N 次重试拉起 */
    retryAttempt: 0,
    /** 数据管道（cdc）实例携带，task / dataflow 实例为 null */
    pipelineId: null,
    finishedAt: null,
    message: null,
    ...data,
    id: data.id || store.nextId(),
    startedAt: timestamp,
  };
  return store.insert(record);
};

const update = (id, patch = {}) => {
  const existing = store.get(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = (id) => store.remove(id) || null;

/**
 * 按状态统计实例数量（运维大盘 GET /statistics/overview 用）。
 * @param {string} [status] 省略则统计全部实例
 */
const countByStatus = (status) =>
  filterList(list(), { filters: status ? { status } : {} }).length;

module.exports = {
  list,
  find,
  page,
  getById,
  create,
  update,
  delete: deleteById,
  count,
  countByStatus,
  findByTask,
  findLatestByTask,
  findRunningByTask,
  clear: store.clear,
};
