/**
 * 任务运行实例仓储（MySQL 实现，契约 1.3 / 1.4）。
 *
 * 与内存版同名同返回结构（返回 Promise）；`trigger` 是 MySQL 保留字，
 * 列名换成 trigger_type，JS 侧键名保持不变（facade 语义 1:1）。
 * dataflow 实例复用 task_id 列、cdc 管道实例用 pipeline_id 列（与内存版字段一致）。
 */
const { defineStore } = require('./sqlStore');
const { nowIso } = require('../memoryStore');

const KEYWORD_FIELDS = ['taskName'];

const store = defineStore({
  table: 'databridge_task_instance',
  idPrefix: 'inst-',
  startId: 3000,
  keywordFields: KEYWORD_FIELDS,
  defaultSort: 'startedAt:desc',
  columns: {
    id: {},
    taskId: {},
    pipelineId: {},
    taskName: {},
    syncMode: {},
    status: {},
    trigger: { col: 'trigger_type' },
    retryAttempt: { type: 'int' },
    progress: { type: 'int' },
    totalRows: { type: 'int' },
    readRows: { type: 'int' },
    writeRows: { type: 'int' },
    rateRowsPerSec: { type: 'int' },
    // 契约 1.3：real = 引擎真实读写，simulate = 模拟推进（由 run.service 判定后写入）
    execMode: { col: 'exec_mode' },
    startedAt: { type: 'datetime' },
    finishedAt: { type: 'datetime' },
    message: { type: 'text' },
  },
});

const list = () => store.list();

const find = (query = {}) =>
  store.find({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'startedAt:desc',
  });

const page = (query = {}) =>
  store.page({
    filters: query.filters || {},
    keyword: query.keyword,
    sort: query.sort || 'startedAt:desc',
    page: query.page,
    size: query.size,
  });

const getById = (id) => store.getById(id);

const count = () => store.count();

/** 某任务的全部实例，按开始时间倒序（status 可选） */
const findByTask = (taskId, status) => find({ filters: status ? { taskId, status } : { taskId }, sort: 'startedAt:desc' });

/** 某任务最近一次实例（/tasks/:id/progress 聚合视图用） */
const findLatestByTask = async (taskId) => (await findByTask(taskId))[0] || null;

/** 某任务当前 running 的实例 */
const findRunningByTask = async (taskId) => (await findByTask(taskId, 'running'))[0] || null;

const create = async (data) => {
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
    retryAttempt: 0,
    pipelineId: null,
    // 与内存版同名同默认值：真实执行模式由 run.service 判定时覆盖
    execMode: 'simulate',
    finishedAt: null,
    message: null,
    ...data,
    id: data.id || (await store.nextId()),
    startedAt: timestamp,
  };
  return store.insert(record);
};

/** 注意：内存版 instance.update 不刷 updatedAt（表里也没有该列） */
const update = async (id, patch = {}) => {
  const existing = await store.getById(id);
  if (!existing) return null;
  return store.replace(id, { ...existing, ...patch, id });
};

const deleteById = async (id) => (await store.deleteById(id)) || null;

/** 按状态统计实例数量（GET /statistics/overview 用；省略 status 统计全部） */
const countByStatus = (status) => store.count(status ? { status } : {});

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
  clear: () => store.clear(),
};
