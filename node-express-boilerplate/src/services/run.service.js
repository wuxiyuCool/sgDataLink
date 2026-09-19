/**
 * 「可运行体」公共编排层 —— 同步任务（1.2）与数据开发（1.8）共用一套 start / stop / progress
 * 以及契约 1.6 要求的两种真实调度行为：定时触发（cron）与失败自动重试。
 *
 * 为什么要抽这一层：dataflow 的运行链路和 task 完全同构
 * （预写 inst- 实例 → 下发引擎快照 → 失败回滚 → 引擎回报刷状态），
 * 只有快照内容与响应键名不同，因此这里用 descriptor 注册的方式承载差异，
 * 两个领域的 service 各自 `registerRunner()` 后把 start/stop/getProgress 转出去，
 * 调度器（scheduler.service）与失败重试只需要面对 registry，不必各写一遍。
 *
 * 【第二阶段替换点】start 里「预写实例 + 调引擎 + 回滚」换成事务化的调度记录即可，
 * 对外函数签名保持不变。
 */
const config = require('../config/config');
const logger = require('../config/logger');
const engineClient = require('../utils/engineClient');
const instanceRepository = require('../repositories/instance.repository');
const offsetRepository = require('../repositories/offset.repository');
const logRepository = require('../repositories/log.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const { paramInvalid, notFound, duplicateStart } = require('../utils/bizError');
const { nowIso } = require('../repositories/memoryStore');

/** 任务 / 画布未声明 totalRows 时的 mock 总行数（引擎按此推进进度） */
const DEFAULT_TOTAL_ROWS = 100000;

/** 调度默认值（docs/API.md 1.2 / 1.8，task 与 dataflow 共用同一套语义） */
const DEFAULT_SCHEDULE = {
  /** null 表示「手动触发」，非空为 6 位 Quartz 子集 cron */
  scheduleCron: null,
  /** 失败重试次数，取值 0~10 */
  retryCount: 3,
  /** 重试间隔（秒） */
  retryIntervalSec: 60,
};

/** 实例触发方式（契约枚举） */
const TRIGGERS = ['manual', 'cron', 'retry'];

/** kind -> descriptor */
const runners = new Map();

/** 排程中的重试定时器，进程退出时统一 clear */
const pendingTimers = new Set();

const toInt = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/** 源/目标库摘要（引擎快照里的 endpoint 结构） */
const endpointOf = (dataSourceId) => {
  const ds = datasourceRepository.getById(dataSourceId) || {};
  return { id: ds.id, type: ds.type, database: ds.database };
};

/** 下发给引擎的通用快照外壳（taskId / instanceId / syncMode / batchSize / reportUrl 等） */
const baseSnapshot = (record, instanceId, { syncMode, totalRows, source, target, extra = {} }) => ({
  taskId: record.id,
  instanceId,
  syncMode,
  batchSize: toInt(record.batchSize, 1000) || 1000,
  totalRows,
  failureRate: resolveFailureRate(record),
  incrementalColumn: record.incrementalColumn || null,
  source,
  target,
  // reportUrl 是引擎回报 Node 的地址（ADMIN_REPORT_URL），容器里用服务名，本地用 127.0.0.1
  reportUrl: config.engine.reportUrl,
  taskName: record.name,
  ...extra,
});

/** failureRate 兜底：未显式配置时按 0（mock 阶段默认必定成功，演示失败态在记录上给值） */
function resolveFailureRate(record) {
  const value = record && record.failureRate;
  if (value !== undefined && value !== null && value !== '') return Number(value);
  return 0;
}

/** 总行数兜底 */
const resolveTotalRows = (record) => toInt(record.totalRows, DEFAULT_TOTAL_ROWS) || DEFAULT_TOTAL_ROWS;

/**
 * 注册一种可运行体（task / dataflow）。
 * @param {Object} descriptor {
 *   kind, label, repository, resultIdKey,
 *   resolveSyncMode(record), buildSnapshot(record, instanceId, totalRows),
 *   instanceExtra(record, options)
 * }
 * @returns {Object} { start, stop, getProgress }
 */
const registerRunner = (descriptor) => {
  const { kind, label, repository, resultIdKey = 'taskId', resolveSyncMode, buildSnapshot, instanceExtra } = descriptor;
  if (!kind || !repository) throw new Error('registerRunner: kind / repository 必填');

  const getByIdOrThrow = (id) => {
    const record = repository.getById(id);
    if (!record) throw notFound(`${label}不存在: ${id}`);
    return record;
  };

  /**
   * 启动：校验 → 预写 running 实例（带 trigger / retryAttempt）→ 刷 lastStatus → 下发引擎快照。
   * 引擎拒绝时回滚实例与状态，避免留下幽灵 running。
   */
  const start = async (id, options = {}) => {
    const trigger = TRIGGERS.includes(options.trigger) ? options.trigger : 'manual';
    const retryAttempt = Math.max(toInt(options.retryAttempt, 0), 0);
    const record = getByIdOrThrow(id);
    if (record.enabled === false) {
      throw paramInvalid(`${label}已禁用，无法启动: ${record.id}`);
    }
    if (record.lastStatus === 'running' || instanceRepository.findRunningByTask(record.id)) {
      throw duplicateStart(`${label}已在运行中，请勿重复启动: ${record.id}`);
    }

    const totalRows = resolveTotalRows(record);
    const instance = instanceRepository.create({
      // dataflow 复用 taskId 承载 dataflowId（契约 1.8：progress 结构里键名仍是 taskId）
      taskId: record.id,
      taskName: record.name,
      syncMode: resolveSyncMode ? resolveSyncMode(record) : record.syncMode,
      status: 'running',
      progress: 0,
      totalRows,
      readRows: 0,
      writeRows: 0,
      rateRowsPerSec: 0,
      trigger,
      retryAttempt,
      startedAt: nowIso(),
      finishedAt: null,
      message: null,
      ...(instanceExtra ? instanceExtra(record, options) : {}),
    });

    const previousStatus = record.lastStatus;
    const previousRunAt = record.lastRunAt;
    repository.update(record.id, { lastStatus: 'running', lastRunAt: instance.startedAt });

    try {
      await engineClient.startTask(buildSnapshot(record, instance.id, totalRows));
    } catch (err) {
      logger.warn('engine start rejected (%s %s), rollback instance %s: %s', kind, record.id, instance.id, err.message);
      instanceRepository.delete(instance.id);
      offsetRepository.deleteByInstance(instance.id);
      repository.update(record.id, { lastStatus: previousStatus, lastRunAt: previousRunAt });
      throw err;
    }

    return { [resultIdKey]: record.id, instanceId: instance.id, status: 'running' };
  };

  /**
   * 停止：调引擎 stop → 实例标记 stopped → lastStatus=stopped。
   * 引擎侧已无该实例（40401）时按「已停止」处理，只更新本地状态。
   */
  const stop = async (id) => {
    const record = getByIdOrThrow(id);
    const instance = instanceRepository.findRunningByTask(record.id);
    if (!instance) {
      throw paramInvalid(`${label}当前没有运行中的实例，无法停止: ${record.id}`);
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
      message: '用户手动停止',
    });
    repository.update(record.id, { lastStatus: 'stopped' });
    return {
      [resultIdKey]: record.id,
      instanceId: instance.id,
      status: (stopped && stopped.status) || 'stopped',
    };
  };

  /** 进度聚合视图：状态 + 进度 + 读写行数 + 当前 offset（键名统一 taskId） */
  const getProgress = (id) => {
    const record = getByIdOrThrow(id);
    const instance = instanceRepository.findLatestByTask(record.id);
    if (!instance) {
      return {
        taskId: record.id,
        instanceId: null,
        status: record.lastStatus,
        progress: 0,
        totalRows: 0,
        readRows: 0,
        writeRows: 0,
        currentOffset: (offsetRepository.findLatestByTask(record.id) || {}).offsetValue || null,
        rateRowsPerSec: 0,
        startedAt: null,
        finishedAt: null,
        message: null,
      };
    }
    const offset = offsetRepository.findLatestByInstance(instance.id);
    const elapsedSec = instance.startedAt
      ? Math.max(
          (new Date(instance.finishedAt || nowIso()).getTime() - new Date(instance.startedAt).getTime()) / 1000,
          0
        )
      : 0;
    const computedRate = elapsedSec > 0 ? Math.round((instance.readRows || 0) / elapsedSec) : 0;
    return {
      taskId: record.id,
      instanceId: instance.id,
      status: instance.status,
      progress: instance.progress || 0,
      totalRows: instance.totalRows || 0,
      readRows: instance.readRows || 0,
      writeRows: instance.writeRows || 0,
      currentOffset: (offset || {}).offsetValue || null,
      rateRowsPerSec: instance.rateRowsPerSec || computedRate,
      startedAt: instance.startedAt,
      finishedAt: instance.finishedAt || null,
      message: instance.message || null,
      trigger: instance.trigger || 'manual',
      retryAttempt: instance.retryAttempt || 0,
    };
  };

  const api = { start, stop, getProgress, getByIdOrThrow };
  runners.set(kind, { ...descriptor, api });
  return api;
};

const getRunner = (kind) => runners.get(kind) || null;

const listRunners = () => Array.from(runners.values());

/**
 * 按记录 id 找它属于哪种可运行体（task-2001 → task，df-7501 → dataflow）。
 * 引擎回报只带一个 taskId，靠这里反查归属，避免在回报里塞类型字段。
 */
const findRunnerByRecordId = (id) => {
  if (!id) return null;
  return listRunners().find((entry) => entry.repository.getById(id)) || null;
};

/** 引擎回报刷 lastStatus（task / dataflow 通用） */
const syncRunStatus = (recordId, status, runAt) => {
  const entry = findRunnerByRecordId(recordId);
  if (!entry) {
    logger.warn('engine report for unknown runnable %s, ignored', recordId);
    return null;
  }
  const record = entry.repository.getById(recordId);
  const patch = { lastStatus: status };
  if (runAt) patch.lastRunAt = runAt;
  return entry.repository.update(recordId, patch);
};

/** 供调度器遍历：所有 kind 下的可调度记录 */
const listSchedulableRecords = () =>
  listRunners().reduce((acc, entry) => {
    const records = entry.repository.list ? entry.repository.list() : entry.repository.find({});
    return acc.concat(records.map((record) => ({ kind: entry.kind, label: entry.label, record })));
  }, []);

const clearTimer = (timer) => {
  clearTimeout(timer);
  pendingTimers.delete(timer);
};

/** 进程退出时清理所有排程中的重试，避免定时器把 Node 挂住 */
const cancelPendingRetries = () => {
  Array.from(pendingTimers).forEach(clearTimer);
  pendingTimers.clear();
};

const pendingRetryCount = () => pendingTimers.size;

/**
 * 失败自动重试（docs/API.md 1.6）：
 * 任务/画布 retryCount>0 且该实例链上已重试次数 < retryCount 时，
 * 等 retryIntervalSec 秒后以 trigger=retry 重新下发，并写「第 N 次重试」INFO 日志。
 *
 * @param {Object} instance 刚回报 failed 的实例
 * @returns {boolean} 是否成功排程
 */
const scheduleRetry = (instance) => {
  if (!instance || !instance.taskId) return false;
  const entry = findRunnerByRecordId(instance.taskId);
  if (!entry) return false;
  const record = entry.repository.getById(instance.taskId);
  const retryCount = toInt(record.retryCount, 0);
  const alreadyTried = toInt(instance.retryAttempt, 0);
  if (retryCount <= 0 || alreadyTried >= retryCount) return false;

  const nextAttempt = alreadyTried + 1;
  const waitSec = Math.max(toInt(record.retryIntervalSec, 0), 0);
  logRepository.create({
    instanceId: instance.id,
    taskId: instance.taskId,
    level: 'INFO',
    message: `第 ${nextAttempt} 次重试：${waitSec}s 后自动重新下发（retryCount=${retryCount}）`,
  });
  logger.info('schedule retry %d/%d for %s in %ds', nextAttempt, retryCount, instance.taskId, waitSec);

  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    // 排程到触发的这段时间里可能已被人工启动 / 已删除，这里全部重新查一遍
    const current = entry.repository.getById(instance.taskId);
    if (!current) {
      logger.warn('retry aborted: %s 已被删除', instance.taskId);
      return;
    }
    if (current.lastStatus === 'running' || instanceRepository.findRunningByTask(current.id)) {
      logger.warn('retry skipped: %s 已在运行中', current.id);
      return;
    }
    entry.api
      .start(current.id, { trigger: 'retry', retryAttempt: nextAttempt })
      .then((result) => {
        logRepository.create({
          instanceId: result.instanceId,
          taskId: current.id,
          level: 'INFO',
          message: `第 ${nextAttempt} 次重试启动（trigger=retry）`,
        });
      })
      .catch((err) => {
        logger.warn('retry %d failed for %s: %s', nextAttempt, current.id, err.message);
        logRepository.create({
          instanceId: instance.id,
          taskId: current.id,
          level: 'WARN',
          message: `第 ${nextAttempt} 次重试下发失败: ${err.message}`,
        });
      });
  }, waitSec * 1000);

  // unref：不能让排程中的重试阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.add(timer);
  return true;
};

module.exports = {
  DEFAULT_TOTAL_ROWS,
  DEFAULT_SCHEDULE,
  TRIGGERS,
  baseSnapshot,
  endpointOf,
  resolveFailureRate,
  resolveTotalRows,
  registerRunner,
  getRunner,
  listRunners,
  findRunnerByRecordId,
  syncRunStatus,
  listSchedulableRecords,
  scheduleRetry,
  cancelPendingRetries,
  pendingRetryCount,
};
