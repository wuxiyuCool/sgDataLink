/**
 * Go 引擎回报处理（docs/API.md 第 1.4 节）。
 *
 * POST /engine/report → 写回实例进度/状态 + 运行体 lastStatus + 点位
 * POST /engine/logs   → 批量写回实例日志
 * 全部落在内存仓储里；第二阶段换成 PG 实现时只改 repository。
 *
 * 除了实例本身，回报链路还要驱动三件「真实行为」：
 * 1) 带 pipelineId 的 cdc 回报 → 刷数据管道运行态（changeRows/qps/lagMs/cdcPosition）与终态（1.7）；
 * 2) failed 回报 → 失败自动重试（retryCount / retryIntervalSec，trigger=retry，1.6）；
 * 3) failed / 管道异常 / 延迟超阈值 → 走告警判定写 alert-record（1.10）。
 */
const logger = require('../config/logger');
const offsetRepository = require('../repositories/offset.repository');
const logRepository = require('../repositories/log.repository');
const pipelineRepository = require('../repositories/pipeline.repository');
const taskInstanceService = require('./taskInstance.service');
const runService = require('./run.service');
const pipelineService = require('./pipeline.service');
const alertService = require('./alert.service');
const { paramInvalid } = require('../utils/bizError');
const { nowIso } = require('../repositories/memoryStore');

const VALID_STATUSES = ['running', 'success', 'failed', 'stopped'];
const VALID_LEVELS = ['INFO', 'WARN', 'ERROR'];
const VALID_TRIGGERS = ['manual', 'cron', 'retry'];

const toInt = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(Math.floor(num), 0) : fallback;
};

const toProgress = (value) => Math.min(Math.max(toInt(value), 0), 100);

/** 引擎回报的 status 白名单（契约枚举，其它值按 40001 拒绝） */
const assertStatus = (status) => {
  if (status !== undefined && status !== null && !VALID_STATUSES.includes(status)) {
    throw paramInvalid(`status 只能是 ${VALID_STATUSES.join('|')}`);
  }
};

/** 运行体（同步任务 / 数据开发）状态跟随实例回报刷新（running / 终态） */
const syncRunStatus = async (taskId, status, finishedAt) => {
  const entry = await runService.findRunnerByRecordId(taskId);
  if (!entry) {
    logger.warn('engine report for unknown runnable %s, ignored', taskId);
    return null;
  }
  const record = (await entry.repository.getById(taskId)) || {};
  const patch = { lastStatus: status };
  if (taskInstanceService.isFinalStatus(status)) {
    patch.lastRunAt = record.lastRunAt || finishedAt || nowIso();
  }
  return entry.repository.update(taskId, patch);
};

/**
 * cdc 管道回报（契约 1.4：带 pipelineId / currentQps / lagMs / cdcPosition，progress 恒 0）。
 * 刷管道运行态，并在进入终态时判定 pipeline_error、之后判定 lag_over_threshold。
 */
const handlePipelineReport = async (pipelineId, payload, status) => {
  const pipeline = await pipelineRepository.getById(pipelineId);
  if (!pipeline) {
    logger.warn('engine report for unknown pipeline %s, ignored', pipelineId);
    return;
  }
  const { becameFailed } = await pipelineService.applyEngineReport(pipeline, { ...payload, status });
  const fresh = await pipelineRepository.getById(pipelineId);

  if (becameFailed) {
    await alertService.onPipelineFailed(fresh, payload.message || (fresh && fresh.lastError));
  }
  // 延迟超阈值：引擎每 tick 都会回报，alert.service 内部按「同管道 + 同规则 60s」去重
  if (fresh && toInt(fresh.lagMs) > 0) {
    await alertService.onPipelineLag(fresh, fresh.lagMs);
  }
};

/**
 * POST /engine/report
 * @param {Object} payload { instanceId, taskId, pipelineId, status, progress, totalRows, readRows,
 *                           writeRows, currentOffset, rateRowsPerSec, currentQps, lagMs, cdcPosition,
 *                           changeRows, trigger, message }
 * @returns {Promise<{ accepted: true }>}
 */
const reportProgress = async (payload = {}) => {
  if (!payload.instanceId) {
    throw paramInvalid('instanceId 必填');
  }
  assertStatus(payload.status);
  const instance = await taskInstanceService.getInstanceOrThrow(payload.instanceId);
  const status = payload.status || instance.status;
  // 管道归属：回报优先，其次看实例创建时写下的 pipelineId
  const pipelineId = payload.pipelineId || instance.pipelineId || null;
  const taskId = payload.taskId || instance.taskId || null;

  const patch = { status };
  if (payload.progress !== undefined) patch.progress = toProgress(payload.progress);
  if (payload.totalRows !== undefined) patch.totalRows = payload.totalRows === null ? null : toInt(payload.totalRows);
  if (payload.readRows !== undefined) patch.readRows = toInt(payload.readRows);
  if (payload.writeRows !== undefined) patch.writeRows = toInt(payload.writeRows);
  if (payload.rateRowsPerSec !== undefined) patch.rateRowsPerSec = toInt(payload.rateRowsPerSec);
  if (payload.message !== undefined) patch.message = payload.message;
  // 契约 1.6：trigger 由 Node 侧决定（manual/cron/retry），引擎若回传则以回报为准
  if (payload.trigger !== undefined && VALID_TRIGGERS.includes(payload.trigger)) patch.trigger = payload.trigger;

  const isFinal = taskInstanceService.isFinalStatus(status);
  if (isFinal) {
    patch.finishedAt = instance.finishedAt || nowIso();
    // cdc 管道没有百分比进度，只有普通任务/画布完成时才补 100
    if (status === 'success' && !pipelineId) patch.progress = 100;
  } else {
    patch.finishedAt = null;
  }
  const updated = (await taskInstanceService.updateInstance(instance.id, patch)) || { ...instance, ...patch };

  if (payload.currentOffset) {
    await offsetRepository.upsert({
      taskId,
      instanceId: instance.id,
      shardKey: payload.shardKey || 'default',
      offsetValue: String(payload.currentOffset),
    });
  }

  if (pipelineId) {
    await handlePipelineReport(pipelineId, payload, status);
  } else if (taskId) {
    await syncRunStatus(taskId, status, patch.finishedAt);
  }

  // 首次进入终态才写终结日志与后续动作，避免同一终态被重复回报时刷屏
  const justFinal = isFinal && instance.status !== status;
  if (justFinal) {
    await logRepository.create({
      instanceId: instance.id,
      taskId,
      level: status === 'failed' ? 'ERROR' : 'INFO',
      message:
        status === 'failed'
          ? `instance finished with status=failed: ${payload.message || 'mock error'}`
          : `instance finished with status=${status}, ${updated ? updated.writeRows : 0} rows written`,
    });
  }

  if (justFinal && status === 'failed' && !pipelineId && taskId) {
    // 1) 告警：condition=task_failed（数据开发实例同样按 task_failed 处理，只是 targetType=dataflow）
    await alertService.onInstanceFailed({ ...instance, ...patch }, payload.message);
    // 2) 契约 1.6 失败重试：retryCount>0 且链上已重试次数未用满时，延后 retryIntervalSec 秒重下
    const scheduled = await runService.scheduleRetry(updated);
    if (!scheduled) {
      logger.debug('no retry scheduled for instance %s (retryCount used up or not configured)', instance.id);
    }
  }

  logger.debug('engine report accepted: %s %s %s%', instance.id, status, patch.progress || 0);
  return { accepted: true };
};

/** 只接受可解析的时间字符串，其它一律落到当前时间，保证 ISO 8601 输出 */
const toIso = (value) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return nowIso();
  return new Date(value).toISOString();
};

/**
 * POST /engine/logs
 * @param {Object} payload { instanceId, logs: [{ level, message }] }
 * @returns {Promise<{ accepted: number }>}
 */
const ingestLogs = async (payload = {}) => {
  if (!payload.instanceId) {
    throw paramInvalid('instanceId 必填');
  }
  if (!Array.isArray(payload.logs)) {
    throw paramInvalid('logs 必须是数组');
  }
  const instance = await taskInstanceService.getInstanceOrThrow(payload.instanceId);
  const items = payload.logs
    .filter((item) => item && item.message)
    .map((item) => ({
      instanceId: instance.id,
      taskId: item.taskId || instance.taskId,
      level: VALID_LEVELS.includes(String(item.level || '').toUpperCase()) ? String(item.level).toUpperCase() : 'INFO',
      message: String(item.message),
      createdAt: toIso(item.createdAt || item.timestamp),
    }));
  const created = await logRepository.createMany(items);
  logger.debug('engine logs accepted: %d for %s', created.length, instance.id);
  return { accepted: created.length };
};

module.exports = {
  reportProgress,
  ingestLogs,
};
