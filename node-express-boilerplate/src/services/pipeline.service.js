/**
 * 数据管道（CDC）业务层（docs/API.md 第 1.7 节，对标 FDL 数据管道）。
 *
 * 与同步任务的差别：管道是「整库/多表实时镜像」，没有百分比进度、也不会自己跑完，
 * 因此不进 run.service 的 start/stop 编排，单独走引擎的 cdc 模式快照：
 *   POST {ENGINE_BASE_URL}/api/v1/engine/tasks/start
 *   { instanceId, pipelineId, taskId: null, syncMode: 'cdc', syncObjects, batchSize, failureRate, reportUrl }
 * 运行态（changeRows / currentQps / lagMs / cdcPosition）由引擎每次 tick 回报刷进管道记录，
 * GET /pipelines/:id/status 直接读这些字段（前端 3s 轮询）。
 *
 * running 禁止改删（40003）、重复启动（40901）的口径与同步任务保持一致。
 */
const pick = require('../utils/pick');
const config = require('../config/config');
const logger = require('../config/logger');
const engineClient = require('../utils/engineClient');
const pipelineRepository = require('../repositories/pipeline.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const instanceRepository = require('../repositories/instance.repository');
const offsetRepository = require('../repositories/offset.repository');
const { paramInvalid, notFound, runningForbidden, duplicateStart } = require('../utils/bizError');
const { nowIso } = require('../repositories/memoryStore');
const runService = require('./run.service');

/** 管道终态：引擎回报这三个状态之一即认为本次镜像链路结束（管道回到 stopped） */
const FINAL_STATUSES = ['success', 'failed', 'stopped'];

/** 管道运行态字段（start 清零、report 刷新、stop 后保留最后一次值便于回看） */
const RUNTIME_FIELDS = ['changeRows', 'currentQps', 'lagMs', 'cdcPosition', 'lastReportAt'];

/** 管道对象没有 batchSize 字段，下发引擎时给的默认批量（契约 2 节 cdc 请求体仍需要） */
const DEFAULT_BATCH_SIZE = 1000;

const isFinalStatus = (status) => FINAL_STATUSES.includes(status);

const getPipelineOrThrow = (id) => {
  const pipeline = pipelineRepository.getById(id);
  if (!pipeline) {
    throw notFound(`数据管道不存在: ${id}`);
  }
  return pipeline;
};

const assertDataSourceExists = (id, label) => {
  if (!id) throw paramInvalid(`${label} 必填`);
  if (!datasourceRepository.getById(id)) {
    throw paramInvalid(`${label} 对应的数据源不存在: ${id}`);
  }
};

const assertNotRunning = (pipeline, action) => {
  if (pipeline.status === 'running') {
    throw runningForbidden(`管道正在运行中，禁止${action}: ${pipeline.id}`);
  }
};

const normalizeBody = (body = {}) => {
  const payload = pick(body, [
    'name',
    'sourceId',
    'targetId',
    'syncObjects',
    'ddlPolicy',
    'batchSize',
    'failureRate',
    'remark',
  ]);
  if (Array.isArray(payload.syncObjects)) {
    payload.syncObjects = payload.syncObjects.map((item) => String(item).trim()).filter(Boolean);
  }
  return payload;
};

/** 管道定义校验：名称 / 两端数据源 / 至少一张同步对象 */
const assertDefinition = (payload) => {
  if (!payload.name) throw paramInvalid('name 必填');
  assertDataSourceExists(payload.sourceId, 'sourceId');
  assertDataSourceExists(payload.targetId, 'targetId');
  if (!Array.isArray(payload.syncObjects) || !payload.syncObjects.length) {
    throw paramInvalid('syncObjects 至少需要一个同步对象（如 APP_USER.T_ORDER）');
  }
};

/** 分页列表：keyword / status / sort */
const queryPipelines = (filter = {}, options = {}) =>
  pipelineRepository.page({
    filters: { status: filter.status, sourceId: filter.sourceId, targetId: filter.targetId },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getPipelineById = (id) => getPipelineOrThrow(id);

const createPipeline = (body) => {
  const payload = normalizeBody(body);
  assertDefinition(payload);
  return pipelineRepository.create({
    ddlPolicy: 'ignore',
    ...payload,
    status: 'stopped',
    runningInstanceId: null,
    lastError: null,
  });
};

const updatePipelineById = (id, body) => {
  const existing = getPipelineOrThrow(id);
  assertNotRunning(existing, '编辑');
  const payload = normalizeBody(body);
  const merged = { ...existing, ...payload };
  if ('name' in payload && !payload.name) throw paramInvalid('name 必填');
  if (payload.sourceId !== undefined) assertDataSourceExists(payload.sourceId, 'sourceId');
  if (payload.targetId !== undefined) assertDataSourceExists(payload.targetId, 'targetId');
  if (payload.syncObjects !== undefined) assertDefinition(merged);
  return pipelineRepository.update(id, payload);
};

const deletePipelineById = (id) => {
  const existing = getPipelineOrThrow(id);
  assertNotRunning(existing, '删除');
  pipelineRepository.delete(existing.id);
  return existing;
};

/** 下发给 Go 引擎的 cdc 快照（字段见 docs/API.md 第 1.7 / 2 节） */
const buildEngineSnapshot = (pipeline, instanceId) => ({
  instanceId,
  pipelineId: pipeline.id,
  // 管道不属于任何同步任务：cdc 回报靠 pipelineId 归属，taskId 恒为 null
  taskId: null,
  syncMode: 'cdc',
  syncObjects: pipeline.syncObjects || [],
  source: runService.endpointOf(pipeline.sourceId),
  target: runService.endpointOf(pipeline.targetId),
  batchSize: Number(pipeline.batchSize) || DEFAULT_BATCH_SIZE,
  failureRate: runService.resolveFailureRate(pipeline),
  reportUrl: config.engine.reportUrl,
});

/** 当前运行中的实例（没有则 null） */
const findRunningInstance = (pipeline) =>
  pipeline.runningInstanceId ? instanceRepository.getById(pipeline.runningInstanceId) : null;

/**
 * 启动管道：校验 → 预写 inst- 实例（syncMode=cdc）→ 运行态清零并置 running → 引擎下发 cdc 快照；
 * 引擎拒绝时回滚实例与管道记录，避免留下幽灵 running。
 * @param {string} id 管道 id
 * @param {Object} [options] { trigger, retryAttempt }
 * @returns {Promise<{pipelineId, instanceId, status}>}
 */
const startPipeline = async (id, options = {}) => {
  const pipeline = getPipelineOrThrow(id);
  if (pipeline.enabled === false) {
    throw paramInvalid(`管道已禁用，无法启动: ${pipeline.id}`);
  }
  if (pipeline.status === 'running' || findRunningInstance(pipeline)) {
    throw duplicateStart(`管道已在运行中，请勿重复启动: ${pipeline.id}`);
  }
  assertDefinition({ ...pipeline, name: pipeline.name });

  const instance = instanceRepository.create({
    // 管道实例不属于任何同步任务，靠 pipelineId 归属（契约 1.4）
    taskId: null,
    pipelineId: pipeline.id,
    taskName: pipeline.name,
    syncMode: 'cdc',
    status: 'running',
    // cdc 模式没有百分比进度：契约 1.4 明确 progress 恒为 0、totalRows 为 null
    progress: 0,
    totalRows: null,
    readRows: 0,
    writeRows: 0,
    rateRowsPerSec: 0,
    trigger: runService.TRIGGERS.includes(options.trigger) ? options.trigger : 'manual',
    retryAttempt: Number(options.retryAttempt) || 0,
    startedAt: nowIso(),
    finishedAt: null,
    message: null,
  });

  const rollback = pick(pipeline, ['status', 'runningInstanceId', 'lastError', 'startedAt']);
  pipelineRepository.update(pipeline.id, {
    status: 'running',
    runningInstanceId: instance.id,
    lastError: null,
    startedAt: instance.startedAt,
    lastReportAt: null,
    changeRows: 0,
    currentQps: 0,
    lagMs: 0,
    cdcPosition: null,
  });

  try {
    await engineClient.startPipeline(buildEngineSnapshot(pipeline, instance.id));
  } catch (err) {
    logger.warn('engine start rejected for pipeline %s, rollback instance %s: %s', pipeline.id, instance.id, err.message);
    instanceRepository.delete(instance.id);
    offsetRepository.deleteByInstance(instance.id);
    pipelineRepository.update(pipeline.id, { ...rollback, changeRows: 0, currentQps: 0, lagMs: 0, cdcPosition: null });
    throw err;
  }

  return { pipelineId: pipeline.id, instanceId: instance.id, status: 'running' };
};

/**
 * 停止管道：引擎 stop → 实例置 stopped → 管道 status=stopped。
 * 引擎侧已无该实例（40401）时按「已停止」处理，只更新本地状态。
 * @returns {Promise<{pipelineId, instanceId, status}>}
 */
const stopPipeline = async (id) => {
  const pipeline = getPipelineOrThrow(id);
  const instance = findRunningInstance(pipeline);
  if (!instance) {
    throw paramInvalid(`管道当前没有运行中的实例，无法停止: ${pipeline.id}`);
  }

  try {
    await engineClient.stopTask(instance.id);
  } catch (err) {
    if (err.bizCode !== 40401) throw err;
    logger.warn('engine has no instance %s, mark it stopped locally', instance.id);
  }

  const stopped = instanceRepository.update(instance.id, {
    status: 'stopped',
    finishedAt: nowIso(),
    message: '用户停止管道',
  });
  // changeRows / cdcPosition 保留最后一次值，qps 与延迟归零（已经不在跑了）
  pipelineRepository.update(pipeline.id, {
    status: 'stopped',
    runningInstanceId: null,
    currentQps: 0,
    lagMs: 0,
    lastReportAt: nowIso(),
  });
  return {
    pipelineId: pipeline.id,
    instanceId: instance.id,
    status: (stopped && stopped.status) || 'stopped',
  };
};

/** GET /pipelines/:id/status —— 实时状态（数据全部来自管道记录的运行态字段） */
const getPipelineStatus = (id) => {
  const pipeline = getPipelineOrThrow(id);
  return {
    pipelineId: pipeline.id,
    instanceId: pipeline.runningInstanceId || null,
    status: pipeline.status,
    changeRows: pipeline.changeRows || 0,
    currentQps: pipeline.currentQps || 0,
    lagMs: pipeline.lagMs || 0,
    cdcPosition: pipeline.cdcPosition || null,
    startedAt: pipeline.startedAt || null,
    lastError: pipeline.lastError || null,
    lastReportAt: pipeline.lastReportAt || null,
    syncObjects: pipeline.syncObjects || [],
  };
};

/**
 * 引擎回报（带 pipelineId）刷管道运行态与终态，由 engineReport.service 调用。
 * @param {Object} pipeline 管道记录（回报前的快照）
 * @param {Object} payload  引擎回报体
 * @returns {{ updated: Object, becameFailed: boolean, becameTerminal: boolean }}
 */
const applyEngineReport = (pipeline, payload = {}) => {
  const status = payload.status || pipeline.status;
  const patch = { lastReportAt: nowIso() };

  // changeRows：优先取引擎显式给的值，否则用 readRows 兜底（cdc 模式下读到的就是变更行数）
  if (payload.changeRows !== undefined) patch.changeRows = Math.max(Number(payload.changeRows) || 0, 0);
  else if (payload.readRows !== undefined) patch.changeRows = Math.max(Number(payload.readRows) || 0, 0);
  if (payload.currentQps !== undefined) patch.currentQps = Math.max(Number(payload.currentQps) || 0, 0);
  if (payload.lagMs !== undefined) patch.lagMs = Math.max(Number(payload.lagMs) || 0, 0);
  if (payload.cdcPosition !== undefined) patch.cdcPosition = payload.cdcPosition || null;
  if (payload.message) patch.lastError = status === 'failed' ? payload.message : pipeline.lastError;

  let becameFailed = false;
  let becameTerminal = false;
  if (isFinalStatus(status) && pipeline.status === 'running') {
    becameTerminal = true;
    becameFailed = status === 'failed';
    patch.status = 'stopped';
    patch.runningInstanceId = null;
    patch.currentQps = 0;
    patch.lagMs = 0;
    if (becameFailed) patch.lastError = payload.message || '管道同步失败';
  }

  const updated = pipelineRepository.update(pipeline.id, patch);
  return { updated: updated || pipeline, becameFailed, becameTerminal };
};

module.exports = {
  FINAL_STATUSES,
  RUNTIME_FIELDS,
  isFinalStatus,
  queryPipelines,
  getPipelineById,
  getPipelineOrThrow,
  createPipeline,
  updatePipelineById,
  deletePipelineById,
  startPipeline,
  stopPipeline,
  getPipelineStatus,
  applyEngineReport,
  buildEngineSnapshot,
  findRunningInstance,
};
