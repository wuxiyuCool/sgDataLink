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
 * 【第二阶段：MySQL 驱动】仓储调用全部 await：
 * start 是「写实例 → 刷 lastStatus → 下发引擎」三段，MySQL 下已不再是一个内存事务，
 * 引擎拒绝时按原逻辑反向回滚（删实例 + 删点位 + 还原状态）；
 * 真正的跨表事务（同一 connection 里 commit/rollback）留到引擎换成真实调度时再接。
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

/** 排程中的重试定时器，进程退出时统一 clear（保持内存态，不落库） */
const pendingTimers = new Set();

const toInt = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

/**
 * 执行模式（docs/API.md 4.1 / 5）：
 * - `real` DB_DRIVER=mysql 且源、目标两端数据源类型都在引擎已具备真实读写能力的驱动白名单内，
 *   引擎快照带完整连接体（含明文 password，仅内网进程间传输），由引擎真连库搬数；
 * - `simulate` 其余一切情况（memory 驱动、postgresql 等尚未接驱动的类型、数据源已缺失），
 *   快照保持旧的摘要结构（id / type / database，**绝不含 password**），引擎按 Mock 规格推进进度。
 */
const EXEC_MODES = ['real', 'simulate'];
const REAL_SYNC_DRIVERS = ['mysql', 'oracle'];

/** 纯判定：给定两端数据源记录算出模式（供 resolveExecMode 与 loadEndpoints 共用） */
const execModeOfDataSources = (sourceDs, targetDs) => {
  if (!config.db.isMysql()) return 'simulate';
  const typeOf = (ds) => String((ds && ds.type) || '').toLowerCase();
  if (!sourceDs || !targetDs) return 'simulate';
  return REAL_SYNC_DRIVERS.includes(typeOf(sourceDs)) && REAL_SYNC_DRIVERS.includes(typeOf(targetDs)) ? 'real' : 'simulate';
};

/**
 * 执行模式判定：只有 mysql 驱动 + 两端类型 ∈ {mysql, oracle} 才是 'real'。
 * @param {string} sourceId 源端数据源 id
 * @param {string} targetId 目标端数据源 id
 * @returns {Promise<'real'|'simulate'>}
 */
const resolveExecMode = async (sourceId, targetId) => {
  if (!config.db.isMysql()) return 'simulate';
  const [sourceDs, targetDs] = await Promise.all([
    datasourceRepository.getById(sourceId),
    datasourceRepository.getById(targetId),
  ]);
  return execModeOfDataSources(sourceDs, targetDs);
};

/** 引擎快照里的 endpoint 结构（mode=real 才给完整连接体，含明文 password） */
const endpointBody = (dataSource, mode = 'simulate', table = null) => {
  const ds = dataSource || {};
  if (mode !== 'real') {
    // 旧的模拟快照结构：只给类型与库名，凭据不出后端
    return { id: ds.id, type: ds.type, database: ds.database };
  }
  return {
    id: ds.id,
    type: ds.type,
    host: ds.host,
    port: ds.port,
    database: ds.database,
    username: ds.username,
    password: ds.password,
    table,
  };
};

/**
 * 取一个数据源并拼成引擎快照的 endpoint。
 * @param {string} dataSourceId 数据源 id
 * @param {Object} [options] { mode: 'real'|'simulate'（缺省 simulate）, table: 调用方给的表名 }
 */
const endpointOf = async (dataSourceId, options = {}) => {
  const { mode = 'simulate', table = null } = options;
  const ds = await datasourceRepository.getById(dataSourceId);
  return endpointBody(ds, mode, table);
};

/**
 * 一次读回两端数据源，同时给出 mode 与两份 endpoint（start 链路的取数复用点）。
 * 显式传 mode 时以入参为准（start 已经为写实例算过一次 mode，不再重复判定）。
 */
const loadEndpoints = async (sourceId, targetId, options = {}) => {
  const { sourceTable = null, targetTable = null, mode } = options;
  const [sourceDs, targetDs] = await Promise.all([
    datasourceRepository.getById(sourceId),
    datasourceRepository.getById(targetId),
  ]);
  const execMode = EXEC_MODES.includes(mode) ? mode : execModeOfDataSources(sourceDs, targetDs);
  return {
    mode: execMode,
    source: endpointBody(sourceDs, execMode, sourceTable),
    target: endpointBody(targetDs, execMode, targetTable),
  };
};

/**
 * 位点原值解析：Node 存的 offsetValue 是 `KEY=value` （cdc/分片可能是 `A=a/B=b` 复合串），
 * 引擎要的 offsetStart 是可直接进 `WHERE col > ?` 的原值。
 * @param {string|null} offsetValue 该任务最新点位的 offsetValue
 * @param {string|null} [column] 增量列名，复合串里优先取它那段
 * @returns {string|null} 解析不出来的串原样返回，空值给 null
 */
const parseOffsetStart = (offsetValue, column = null) => {
  if (offsetValue === null || offsetValue === undefined || offsetValue === '') return null;
  const text = String(offsetValue).trim();
  const segments = text
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const pairs = segments.map((segment) => {
    const index = segment.indexOf('=');
    return index < 0 ? null : { key: segment.slice(0, index).trim(), value: segment.slice(index + 1).trim() };
  });
  // 纯位点串（没有 KEY= 结构）原样给引擎，由引擎自己解释
  if (segments.length === 1 && !pairs[0]) return text;
  const wanted = column ? String(column).trim().toLowerCase() : null;
  const matched =
    pairs.find((pair) => pair && wanted && pair.key.toLowerCase() === wanted) ||
    pairs.find((pair) => pair && /time|scn|lsn|pos|rowid|id$/i.test(pair.key)) ||
    pairs.find((pair) => pair);
  return matched ? matched.value || null : text;
};

/**
 * 该任务上一次持久化的位点（增量续传的起点）：取最新一条 offset 记录的 offsetValue 解析原值。
 * @param {string} taskId 同步任务 id
 * @param {string|null} [column] 增量列名
 * @returns {Promise<string|null>}
 */
const resolveOffsetStart = async (taskId, column = null) => {
  const latest = await offsetRepository.findLatestByTask(taskId);
  return latest ? parseOffsetStart(latest.offsetValue, column) : null;
};

/** failureRate 兜底：未显式配置时按 0（mock 阶段默认必定成功，演示失败态在记录上给值） */
function resolveFailureRate(record) {
  const value = record && record.failureRate;
  if (value !== undefined && value !== null && value !== '') return Number(value);
  return 0;
}

/**
 * 下发给引擎的通用快照外壳（taskId / instanceId / syncMode / batchSize / reportUrl 等）。
 * `mode` 是两种模式共有的新增字段（引擎据此决定真实读写还是按 Mock 规格推进）；
 * 契约 5 的 real 专有字段（fieldMappings / offsetStart / table）由调用方按 mode 决定是否附加，
 * simulate 快照因此与改造前逐字段一致。
 */
const baseSnapshot = (record, instanceId, { syncMode, totalRows, source, target, mode = 'simulate', extra = {} }) => ({
  taskId: record.id,
  instanceId,
  syncMode,
  mode,
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

/** 总行数兜底 */
const resolveTotalRows = (record) => toInt(record.totalRows, DEFAULT_TOTAL_ROWS) || DEFAULT_TOTAL_ROWS;

/**
 * 注册一种可运行体（task / dataflow）。
 * @param {Object} descriptor {
 *   kind, label, repository, resultIdKey,
 *   resolveSyncMode(record), buildSnapshot(record, instanceId, totalRows, context),
 *   resolveExecMode(record) -> 'real'|'simulate'（缺省按 simulate 处理）,
 *   instanceExtra(record, options)
 * }
 * @returns {Object} { start, stop, getProgress, getByIdOrThrow }
 */
const registerRunner = (descriptor) => {
  const {
    kind,
    label,
    repository,
    resultIdKey = 'taskId',
    resolveSyncMode,
    buildSnapshot,
    instanceExtra,
    resolveExecMode: resolveModeOfRecord,
  } = descriptor;
  if (!kind || !repository) throw new Error('registerRunner: kind / repository 必填');

  const getByIdOrThrow = async (id) => {
    const record = await repository.getById(id);
    if (!record) throw notFound(`${label}不存在: ${id}`);
    return record;
  };

  /** 本次下发的执行模式（descriptor 未声明时按 simulate，绝不会被误判成 real） */
  const modeOfRecord = async (record) => {
    if (!resolveModeOfRecord) return 'simulate';
    const mode = await resolveModeOfRecord(record);
    return mode === 'real' ? 'real' : 'simulate';
  };

  /**
   * 启动：校验 → 判定 execMode → 预写 running 实例（带 trigger / retryAttempt / execMode）
   * → 刷 lastStatus → 下发引擎快照。引擎拒绝时回滚实例与状态，避免留下幽灵 running。
   * simulate 会补一条 WARN 日志说明「本次不是真实读写」（契约 4.1，前端据此打「模拟」Tag）。
   */
  const start = async (id, options = {}) => {
    const trigger = TRIGGERS.includes(options.trigger) ? options.trigger : 'manual';
    const retryAttempt = Math.max(toInt(options.retryAttempt, 0), 0);
    const record = await getByIdOrThrow(id);
    if (record.enabled === false) {
      throw paramInvalid(`${label}已禁用，无法启动: ${record.id}`);
    }
    if (record.lastStatus === 'running' || (await instanceRepository.findRunningByTask(record.id))) {
      throw duplicateStart(`${label}已在运行中，请勿重复启动: ${record.id}`);
    }

    const totalRows = resolveTotalRows(record);
    const execMode = await modeOfRecord(record);
    const instance = await instanceRepository.create({
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
      // 契约 1.3：本次运行是真实读写还是模拟推进
      execMode,
      startedAt: nowIso(),
      finishedAt: null,
      message: null,
      ...(instanceExtra ? instanceExtra(record, options) : {}),
    });

    const previousStatus = record.lastStatus;
    const previousRunAt = record.lastRunAt;
    await repository.update(record.id, { lastStatus: 'running', lastRunAt: instance.startedAt });

    try {
      await engineClient.startTask(await buildSnapshot(record, instance.id, totalRows, { mode: execMode }));
    } catch (err) {
      logger.warn('engine start rejected (%s %s), rollback instance %s: %s', kind, record.id, instance.id, err.message);
      await Promise.all([
        instanceRepository.delete(instance.id),
        offsetRepository.deleteByInstance(instance.id),
        repository.update(record.id, { lastStatus: previousStatus, lastRunAt: previousRunAt }),
      ]);
      throw err;
    }

    if (execMode === 'simulate') {
      // 下发成功后再写，避免引擎拒绝走回滚时留下挂在已删实例上的孤儿日志
      await logRepository.create({
        instanceId: instance.id,
        taskId: record.id,
        level: 'WARN',
        message: '本次为模拟执行（数据源类型或驱动不支持真实读写）',
      });
    }

    return { [resultIdKey]: record.id, instanceId: instance.id, status: 'running' };
  };

  /**
   * 停止：调引擎 stop → 实例标记 stopped → lastStatus=stopped。
   * 引擎侧已无该实例（40401）时按「已停止」处理，只更新本地状态。
   */
  const stop = async (id) => {
    const record = await getByIdOrThrow(id);
    const instance = await instanceRepository.findRunningByTask(record.id);
    if (!instance) {
      throw paramInvalid(`${label}当前没有运行中的实例，无法停止: ${record.id}`);
    }

    try {
      await engineClient.stopTask(instance.id);
    } catch (err) {
      if (err.bizCode !== 40401) throw err;
      logger.warn('engine has no instance %s, mark it stopped locally', instance.id);
    }

    const stopped = await instanceRepository.update(instance.id, {
      status: 'stopped',
      finishedAt: nowIso(),
      message: '用户手动停止',
    });
    await repository.update(record.id, { lastStatus: 'stopped' });
    return {
      [resultIdKey]: record.id,
      instanceId: instance.id,
      status: (stopped && stopped.status) || 'stopped',
    };
  };

  /** 进度聚合视图：状态 + 进度 + 读写行数 + 当前 offset + execMode（键名统一 taskId） */
  const getProgress = async (id) => {
    const record = await getByIdOrThrow(id);
    const instance = await instanceRepository.findLatestByTask(record.id);
    if (!instance) {
      const fallbackOffset = (await offsetRepository.findLatestByTask(record.id)) || {};
      return {
        taskId: record.id,
        instanceId: null,
        status: record.lastStatus,
        progress: 0,
        totalRows: 0,
        readRows: 0,
        writeRows: 0,
        currentOffset: fallbackOffset.offsetValue || null,
        rateRowsPerSec: 0,
        startedAt: null,
        finishedAt: null,
        message: null,
        // 没有实例就谈不上执行模式（契约 1.2 progress 的可选字段）
        execMode: null,
      };
    }
    const offset = await offsetRepository.findLatestByInstance(instance.id);
    const elapsedSec = instance.startedAt
      ? Math.max((new Date(instance.finishedAt || nowIso()).getTime() - new Date(instance.startedAt).getTime()) / 1000, 0)
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
      // 契约 1.3：本次运行是真实读写（real）还是模拟推进（simulate）
      execMode: instance.execMode || null,
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
 * @returns {Promise<Object|null>} registry 条目
 */
const findRunnerByRecordId = async (id) => {
  if (!id) return null;
  const entries = listRunners();
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    if (await entry.repository.getById(id)) return entry;
  }
  return null;
};

/** 引擎回报刷 lastStatus（task / dataflow 通用） */
const syncRunStatus = async (recordId, status, runAt) => {
  const entry = await findRunnerByRecordId(recordId);
  if (!entry) {
    logger.warn('engine report for unknown runnable %s, ignored', recordId);
    return null;
  }
  const patch = { lastStatus: status };
  if (runAt) patch.lastRunAt = runAt;
  return entry.repository.update(recordId, patch);
};

/** 供调度器遍历：所有 kind 下的可调度记录 */
const listSchedulableRecords = async () => {
  const groups = await Promise.all(
    listRunners().map(async (entry) => {
      const records = entry.repository.list ? await entry.repository.list() : await entry.repository.find({});
      return records.map((record) => ({ kind: entry.kind, label: entry.label, record }));
    })
  );
  return groups.reduce((acc, group) => acc.concat(group), []);
};

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
 * 定时器与「已排程」状态刻意保持内存态：重启后未触发的重试不续命，
 * 语义与内存版一致，也不会让 DB 成为重启后自动下发任务的来源。
 *
 * @param {Object} instance 刚回报 failed 的实例
 * @returns {Promise<boolean>} 是否成功排程
 */
const scheduleRetry = async (instance) => {
  if (!instance || !instance.taskId) return false;
  const entry = await findRunnerByRecordId(instance.taskId);
  if (!entry) return false;
  const record = await entry.repository.getById(instance.taskId);
  if (!record) return false;
  const retryCount = toInt(record.retryCount, 0);
  const alreadyTried = toInt(instance.retryAttempt, 0);
  if (retryCount <= 0 || alreadyTried >= retryCount) return false;

  const nextAttempt = alreadyTried + 1;
  const waitSec = Math.max(toInt(record.retryIntervalSec, 0), 0);
  await logRepository.create({
    instanceId: instance.id,
    taskId: instance.taskId,
    level: 'INFO',
    message: `第 ${nextAttempt} 次重试：${waitSec}s 后自动重新下发（retryCount=${retryCount}）`,
  });
  logger.info('schedule retry %d/%d for %s in %ds', nextAttempt, retryCount, instance.taskId, waitSec);

  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    // 排程到触发的这段时间里可能已被人工启动 / 已删除，这里全部重新查一遍
    const run = async () => {
      const current = await entry.repository.getById(instance.taskId);
      if (!current) {
        logger.warn('retry aborted: %s 已被删除', instance.taskId);
        return;
      }
      if (current.lastStatus === 'running' || (await instanceRepository.findRunningByTask(current.id))) {
        logger.warn('retry skipped: %s 已在运行中', current.id);
        return;
      }
      try {
        const result = await entry.api.start(current.id, { trigger: 'retry', retryAttempt: nextAttempt });
        await logRepository.create({
          instanceId: result.instanceId,
          taskId: current.id,
          level: 'INFO',
          message: `第 ${nextAttempt} 次重试启动（trigger=retry）`,
        });
      } catch (err) {
        logger.warn('retry %d failed for %s: %s', nextAttempt, current.id, err.message);
        await logRepository.create({
          instanceId: instance.id,
          taskId: current.id,
          level: 'WARN',
          message: `第 ${nextAttempt} 次重试下发失败: ${err.message}`,
        });
      }
    };
    run().catch((err) => logger.error('retry tick error for %s: %s', instance.taskId, err.message));
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
  EXEC_MODES,
  REAL_SYNC_DRIVERS,
  baseSnapshot,
  endpointOf,
  loadEndpoints,
  resolveExecMode,
  parseOffsetStart,
  resolveOffsetStart,
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
