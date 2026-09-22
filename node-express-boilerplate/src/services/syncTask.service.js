/**
 * 同步任务业务层（docs/API.md 第 1.2 节）。
 *
 * 覆盖：CRUD + 启动 / 停止（经 utils/engineClient 下发给 Go 引擎）+ 进度聚合视图。
 * running 状态的保护统一走 40003，重复启动走 40901，引用不存在的数据源走 40001。
 *
 * start / stop / progress 的实际编排在 services/run.service.js：
 * 任务与数据开发（1.8）的运行链路同构，共用一处实现，
 * 契约 1.6 的定时触发与失败重试也因此只需要写一遍。
 */
const pick = require('../utils/pick');
const taskRepository = require('../repositories/task.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const { paramInvalid, notFound, runningForbidden } = require('../utils/bizError');
const runService = require('./run.service');

/**
 * 调度相关默认值（docs/API.md 1.2，对标 FineDataLink）。
 * 从 Mock 阶段起是真实行为：scheduleCron 由 services/scheduler.service.js 每秒扫描触发，
 * retryCount / retryIntervalSec 由 run.service.scheduleRetry 在收到 failed 回报后执行。
 */
const { DEFAULT_SCHEDULE } = runService;

const getTaskOrThrow = async (id) => {
  const task = await taskRepository.getById(id);
  if (!task) {
    throw notFound(`同步任务不存在: ${id}`);
  }
  return task;
};

const assertDataSourceExists = async (id, label) => {
  if (!id) {
    throw paramInvalid(`${label} 必填`);
  }
  if (!(await datasourceRepository.getById(id))) {
    throw paramInvalid(`${label} 对应的数据源不存在: ${id}`);
  }
};

/** incremental 模式必须给出增量字段，否则 40001 */
const assertIncrementalColumn = (syncMode, incrementalColumn) => {
  if (syncMode === 'incremental' && !incrementalColumn) {
    throw paramInvalid('incremental 模式必须提供 incrementalColumn');
  }
};

const assertNotRunning = (task, action) => {
  if (task.lastStatus === 'running') {
    throw runningForbidden(`任务正在运行中，禁止${action}: ${task.id}`);
  }
};

const normalizeBody = (body = {}) => {
  const payload = pick(body, [
    'name',
    'syncMode',
    'sourceId',
    'sourceTable',
    'targetId',
    'targetTable',
    'writeMode',
    'batchSize',
    'incrementalColumn',
    'fieldMappings',
    'scheduleCron',
    'retryCount',
    'retryIntervalSec',
    'enabled',
    'remark',
    'totalRows',
    'failureRate',
  ]);
  if (payload.incrementalColumn === '') payload.incrementalColumn = null;
  if (payload.scheduleCron === '') payload.scheduleCron = null;
  return payload;
};

/** 分页列表：keyword / syncMode / lastStatus / sort */
const queryTasks = (filter = {}, options = {}) =>
  taskRepository.page({
    filters: { syncMode: filter.syncMode, lastStatus: filter.lastStatus, enabled: filter.enabled },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

/** 详情（含 fieldMappings） */
const getTaskById = (id) => getTaskOrThrow(id);

const createTask = async (body) => {
  const payload = normalizeBody(body);
  if (!payload.name) throw paramInvalid('name 必填');
  const syncMode = payload.syncMode || 'full';
  assertIncrementalColumn(syncMode, payload.incrementalColumn);
  await assertDataSourceExists(payload.sourceId, 'sourceId');
  await assertDataSourceExists(payload.targetId, 'targetId');
  const task = await taskRepository.create({
    writeMode: 'insert',
    batchSize: 1000,
    fieldMappings: [],
    ...DEFAULT_SCHEDULE,
    ...payload,
    syncMode,
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
    lastStatus: 'idle',
    lastRunAt: null,
  });
  return task;
};

const updateTaskById = async (id, body) => {
  const existing = await getTaskOrThrow(id);
  assertNotRunning(existing, '编辑');
  const payload = normalizeBody(body);
  const syncMode = payload.syncMode || existing.syncMode;
  const incrementalColumn = payload.incrementalColumn === undefined ? existing.incrementalColumn : payload.incrementalColumn;
  assertIncrementalColumn(syncMode, incrementalColumn);
  if (payload.sourceId !== undefined) await assertDataSourceExists(payload.sourceId, 'sourceId');
  if (payload.targetId !== undefined) await assertDataSourceExists(payload.targetId, 'targetId');
  if (payload.enabled !== undefined) payload.enabled = Boolean(payload.enabled);
  return taskRepository.update(id, payload);
};

const deleteTaskById = async (id) => {
  const existing = await getTaskOrThrow(id);
  assertNotRunning(existing, '删除');
  await taskRepository.delete(existing.id);
  return existing;
};

/**
 * 下发给 Go 引擎的任务快照（docs/API.md 第 2 节）。
 * 注意：scheduleCron / retryCount / retryIntervalSec 由 Node 侧的调度器与重试逻辑消费，
 * 不进快照；fieldMappings[].transform 是转换组件占位，Mock 阶段也不参与引擎执行。
 */
const buildEngineSnapshot = async (task, instanceId, totalRows) => {
  const [source, target] = await Promise.all([runService.endpointOf(task.sourceId), runService.endpointOf(task.targetId)]);
  return runService.baseSnapshot(task, instanceId, {
    syncMode: task.syncMode,
    totalRows,
    source,
    target,
    extra: {
      sourceTable: task.sourceTable,
      targetTable: task.targetTable,
      writeMode: task.writeMode || 'insert',
    },
  });
};

/** task 这一种「可运行体」的注册：start / stop / progress 的编排在 run.service 里 */
const runApi = runService.registerRunner({
  kind: 'task',
  label: '同步任务',
  repository: taskRepository,
  resultIdKey: 'taskId',
  resolveSyncMode: (task) => task.syncMode,
  buildSnapshot: buildEngineSnapshot,
});

/**
 * 启动任务（POST /tasks/:id/start，也可被调度器 / 重试逻辑直接调用）：
 * 1) 校验任务存在 / 已启用 / 未在 running（否则 40901）
 * 2) 预生成 inst- 前缀实例并写入内存（status=running，带 trigger / retryAttempt）
 * 3) 调 Go 引擎 start；失败则回滚实例与任务状态
 * @param {string} id 任务 id
 * @param {Object} [options] { trigger: 'manual'|'cron'|'retry', retryAttempt }
 * @returns {Promise<{taskId, instanceId, status}>}
 */
const startTask = (id, options = {}) => runApi.start(id, options);

/** 停止任务：调引擎 stop → 实例标记 stopped → 任务 lastStatus=stopped */
const stopTask = (id) => runApi.stop(id);

/** 进度聚合视图：状态 + 进度 + 读写行数 + 当前 offset（docs/API.md 1.2） */
const getProgress = (id) => runApi.getProgress(id);

module.exports = {
  queryTasks,
  getTaskById,
  getTaskOrThrow,
  createTask,
  updateTaskById,
  deleteTaskById,
  startTask,
  stopTask,
  getProgress,
  buildEngineSnapshot,
  resolveFailureRate: runService.resolveFailureRate,
};
