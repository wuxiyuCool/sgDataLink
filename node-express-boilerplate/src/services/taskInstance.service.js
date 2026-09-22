/**
 * 任务运行实例业务层（docs/API.md 第 1.3 节）。
 *
 * 负责实例列表 / 详情 / 日志 / 点位查询，并对外提供实例状态流转 helper，
 * 供 syncTask.service（stop）与 engineReport.service（引擎回报）复用。
 * 另提供 getStatisticsOverview()：运维大盘统计（docs/API.md 第 1.5 节）。
 */
const pick = require('../utils/pick');
const logger = require('../config/logger');
const instanceRepository = require('../repositories/instance.repository');
const taskRepository = require('../repositories/task.repository');
const logRepository = require('../repositories/log.repository');
const offsetRepository = require('../repositories/offset.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const pipelineRepository = require('../repositories/pipeline.repository');
const dataflowRepository = require('../repositories/dataflow.repository');
const dataApiRepository = require('../repositories/dataapi.repository');
const alertRecordRepository = require('../repositories/alertrecord.repository');
const { notFound } = require('../utils/bizError');

/** 实例状态终态集合 */
const FINAL_STATUSES = ['success', 'failed', 'stopped'];

/** 运维大盘 recentTrend 的天数（含当天），docs/API.md 1.5 固定 7 天 */
const TREND_DAYS = 7;

/** 运维大盘「数据服务 TOP N」条数（docs/API.md 1.5 topDataApis） */
const TOP_DATAAPI_LIMIT = 5;

/** 运维大盘最新告警条数（docs/API.md 1.5 recentAlerts） */
const RECENT_ALERT_LIMIT = 8;

/** 运维大盘最新日志条数（docs/API.md 1.5 recentLogs） */
const RECENT_LOG_LIMIT = 15;

/** datasourceTypes 固定输出的类型（计数为 0 也输出，前端不用再补键） */
const DATASOURCE_TYPE_ORDER = ['oracle', 'mysql', 'postgresql'];

/** taskModeDistribution 固定输出的模式：任务 full/incremental + 管道算 cdc + 数据开发算 dataflow */
const TASK_MODE_ORDER = ['full', 'incremental', 'cdc', 'dataflow'];

const DAY_MS = 24 * 60 * 60 * 1000;

const isFinalStatus = (status) => FINAL_STATUSES.includes(status);

const getInstanceOrThrow = async (id) => {
  const instance = await instanceRepository.getById(id);
  if (!instance) {
    throw notFound(`任务实例不存在: ${id}`);
  }
  return instance;
};

/** GET /task-instances —— 支持 taskId / status / trigger / keyword(taskName) / sort */
const queryInstances = async (filter = {}, options = {}) => {
  const page = await instanceRepository.page({
    filters: { taskId: filter.taskId, status: filter.status, trigger: filter.trigger, pipelineId: filter.pipelineId },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
  return { ...page, items: await Promise.all(page.items.map(withTaskName)) };
};

/** GET /tasks/:id/instances —— 某个任务的实例分页 */
const queryTaskInstances = async (taskId, options = {}) => {
  if (!(await taskRepository.getById(taskId))) {
    throw notFound(`同步任务不存在: ${taskId}`);
  }
  return queryInstances({ taskId }, options);
};

/** 实例上补齐 taskName（内存仓储不 join；mysql 版同样是按 taskId 反查一次任务） */
const withTaskName = async (instance) => {
  if (instance && !instance.taskName) {
    const task = instance.taskId ? await taskRepository.getById(instance.taskId) : null;
    return { ...instance, taskName: task ? task.name : null };
  }
  return instance;
};

/** GET /task-instances/:id */
const getInstanceById = async (id) => withTaskName(await getInstanceOrThrow(id));

/** GET /task-instances/:id/logs —— 支持 level / keyword / sort */
const getInstanceLogs = async (id, filter = {}, options = {}) => {
  const instance = await getInstanceOrThrow(id);
  const page = await logRepository.page({
    filters: { instanceId: instance.id, level: filter.level },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
  return {
    ...page,
    items: page.items.map((log) => pick(log, ['id', 'instanceId', 'taskId', 'level', 'message', 'createdAt'])),
  };
};

/** GET /task-instances/:id/offsets */
const getInstanceOffsets = async (id, options = {}) => {
  const instance = await getInstanceOrThrow(id);
  return offsetRepository.page({
    filters: { instanceId: instance.id, shardKey: options.shardKey },
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
};

/**
 * 引擎回报 / 用户停止共用的状态写入。
 * @param {string} id 实例 id
 * @param {Object} patch 进度字段
 * @returns {Promise<Object|null>}
 */
const updateInstance = (id, patch = {}) => instanceRepository.update(id, patch);

/**
 * ---- 运维统计（docs/API.md 第 1.5 节，对标 FDL 运维监控大盘）----
 * 时间口径统一用 UTC 日期（YYYY-MM-DD），与契约「时间统一 ISO 8601（UTC）」一致。
 */

/** 'YYYY-MM-DD'：非法 / 缺失时间一律返回 null，不参与聚合（入参为 ISO 串或毫秒时间戳） */
const utcDateOf = (value) => {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
};

/** 今天的 UTC 日期 'YYYY-MM-DD' */
const todayUtcDate = () => new Date().toISOString().slice(0, 10);

/** 最近 days 天（含当天）的日期数组，按日期升序 */
const recentDates = (days = TREND_DAYS) => {
  const todayStart = Date.parse(`${todayUtcDate()}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) =>
    new Date(todayStart - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10)
  );
};

const countInstancesByStatus = (instances, status) => instances.filter((item) => item.status === status).length;

/**
 * 大盘子聚合的容错包装：一条数据源查询失败只让它自己的卡片变空，
 * 不允许把整个 GET /statistics/overview 拖成 500。
 * @param {string} name 子聚合名（写 warn 日志用）
 * @param {Function} loader 返回 Promise 的聚合函数
 * @param {any} fallback 失败兜底值（数组 / null / 对象）
 */
const safeAggregate = async (name, loader, fallback) => {
  try {
    return await loader();
  } catch (error) {
    logger.warn('statistics sub-aggregation %s skipped: %s', name, (error && error.message) || error);
    return fallback;
  }
};

/**
 * 按 key 分组计数，输出顺序固定为 order（未知 key 追加在后），
 * order 里出现但数据为空的 key 也输出 count: 0，保证前端图表键稳定。
 * @param {Array} list 记录数组
 * @param {Function} keyOf 取分组键
 * @param {string[]} [order] 固定输出顺序
 * @returns {Array<{key: string, count: number}>}
 */
const groupCount = (list, keyOf, order = []) => {
  const counts = new Map();
  (list || []).forEach((item) => {
    const key = keyOf(item);
    if (key === undefined || key === null || key === '') return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const keys = [...order, ...[...counts.keys()].filter((key) => !order.includes(key))];
  return keys.map((key) => ({ key, count: counts.get(key) || 0 }));
};

/** 数据源类型分布：[{ type, count }]，oracle/mysql/postgresql 恒定输出 */
const buildDatasourceTypes = async () => {
  const list = await datasourceRepository.list();
  return groupCount(list, (item) => item.type, DATASOURCE_TYPE_ORDER).map(({ key, count }) => ({
    type: key,
    count,
  }));
};

/**
 * 任务类型分布：[{ mode, count }]，对标 FDL「任务类型」饼图。
 * full / incremental 来自同步任务，管道算 cdc（契约 0：syncMode=cdc 由 /pipelines 承载），
 * 数据开发（ETL 画布）算 dataflow。
 */
const buildTaskModeDistribution = async () => {
  const [tasks, pipelines, dataflows] = await Promise.all([
    taskRepository.find({}),
    pipelineRepository.list(),
    dataflowRepository.list(),
  ]);
  const taskModes = groupCount(tasks, (item) => item.syncMode);
  const countOf = (mode) => {
    if (mode === 'cdc') return (pipelines || []).length;
    if (mode === 'dataflow') return (dataflows || []).length;
    return (taskModes.find((item) => item.key === mode) || { count: 0 }).count;
  };
  return TASK_MODE_ORDER.map((mode) => ({ mode, count: countOf(mode) }));
};

/** 运行中的数据管道：{ count, maxLagMs }，无运行管道时 maxLagMs 为 null（区别于「延迟 0ms」） */
const buildRunningPipelines = async () => {
  const pipelines = await pipelineRepository.findRunning();
  const lags = (pipelines || [])
    .map((item) => Number(item.lagMs))
    .filter((value) => Number.isFinite(value));
  return {
    count: (pipelines || []).length,
    maxLagMs: lags.length ? Math.max(...lags) : null,
  };
};

/**
 * 数据服务口径（一次 list 查询算全，避免多次回表）：
 * - topDataApis：仅 published，按 invokeCount 降序前 TOP_DATAAPI_LIMIT 条（同调用量按名称升序稳定排序）
 * - dataApiTotal / publishedDataApis：总量与已发布量，供大盘 KPI 卡使用
 */
const buildDataApiStats = async () => {
  const all = (await dataApiRepository.list()) || [];
  const published = all.filter((item) => item.status === 'published');
  const topDataApis = published
    .slice()
    .sort((a, b) => {
      const diff = Number(b.invokeCount || 0) - Number(a.invokeCount || 0);
      return diff || String(a.name || '').localeCompare(String(b.name || ''));
    })
    .slice(0, TOP_DATAAPI_LIMIT)
    .map((item) => ({
      ...pick(item, ['id', 'name', 'path', 'invokeCount', 'errorCount', 'avgLatencyMs']),
      invokeCount: Number(item.invokeCount || 0),
      errorCount: Number(item.errorCount || 0),
      avgLatencyMs: Number(item.avgLatencyMs || 0),
    }));
  return { topDataApis, dataApiTotal: all.length, publishedDataApis: published.length };
};

/**
 * 数据服务调用明细聚合（契约 1.5 dataApiCallStats，供「服务监控」大屏）。
 * 聚合整体在仓储侧完成（mysql 走 databridge_data_api_call 表的条件聚合，
 * 内存版走同名方法的数组归并），这里只多包一层，让 safeAggregate 有明确的失败边界。
 */
const buildDataApiCallStats = async () => (await dataApiRepository.callStats()) || null;

/** 最新告警记录（契约 1.10 的 alert-record 子集字段），前 RECENT_ALERT_LIMIT 条 */
const buildRecentAlerts = async () => {
  const result = await alertRecordRepository.page({
    sort: 'createdAt:desc',
    page: 1,
    size: RECENT_ALERT_LIMIT,
  });
  return (result.items || []).map((item) => ({
    ...pick(item, ['id', 'level', 'targetName', 'message', 'createdAt']),
    // read 为 undefined（老数据没这个键）时按未读处理，与 alertrecord.countUnread 同口径
    read: item.read === true,
  }));
};

/**
 * 最新运行日志（run_log 倒序 RECENT_LOG_LIMIT 条）。
 * @param {Map<string, string>} instanceNames 实例 id -> 任务/管道名（复用大盘已取到的实例列表，不再回表）
 */
const buildRecentLogs = async (instanceNames) => {
  const result = await logRepository.page({
    sort: 'createdAt:desc',
    page: 1,
    size: RECENT_LOG_LIMIT,
  });
  return (result.items || []).map((item) => ({
    ...pick(item, ['id', 'level', 'message', 'instanceId', 'taskId', 'createdAt']),
    taskName: (item.instanceId && instanceNames.get(item.instanceId)) || null,
  }));
};

/**
 * GET /statistics/overview 响应 result。
 * 今日 / 趋势按实例 startedAt 的 UTC 日期聚合，recentTrend 固定 TREND_DAYS 条且日期升序。
 * 新增的字段（契约 1.5）各自单独容错，互不影响：任一子聚合失败只回退成空数组 / null。
 * @returns {Promise<Object>} { datasourceTotal, taskTotal, runningInstances, todayTotal, todaySuccess,
 *                     todayFailed, todayStopped, recentTrend: [{ date, success, failed }],
 *                     datasourceTypes, taskModeDistribution, runningPipelines,
 *                     topDataApis, dataApiTotal, publishedDataApis, dataApiCallStats,
 *                     recentAlerts, recentLogs, todayRunning, weekSuccessRate }
 */
const getStatisticsOverview = async () => {
  const [instances, datasourceTotal, taskTotal, runningInstances] = await Promise.all([
    instanceRepository.list(),
    datasourceRepository.count(),
    taskRepository.count(),
    instanceRepository.countByStatus('running'),
  ]);
  const today = todayUtcDate();

  const todayInstances = instances.filter((item) => utcDateOf(item.startedAt) === today);

  // 先按日期建好 7 个空桶，保证「无数据也要有那根柱子」，再按 startedAt 归桶
  const trendMap = new Map(recentDates().map((date) => [date, { date, success: 0, failed: 0 }]));
  instances.forEach((item) => {
    const bucket = trendMap.get(utcDateOf(item.startedAt));
    if (!bucket) return;
    if (item.status === 'success') bucket.success += 1;
    else if (item.status === 'failed') bucket.failed += 1;
  });
  const recentTrend = Array.from(trendMap.values());

  // 实例 -> 名称（cdc 管道实例的 taskName 是管道名，同样能反查）
  const instanceNames = new Map(
    instances.filter((item) => item.id).map((item) => [item.id, item.taskName || item.taskId || null])
  );

  const [datasourceTypes, taskModeDistribution, runningPipelines, dataApis, dataApiCallStats, recentAlerts, recentLogs] =
    await Promise.all([
      safeAggregate('datasourceTypes', buildDatasourceTypes, []),
      safeAggregate('taskModeDistribution', buildTaskModeDistribution, []),
      safeAggregate('runningPipelines', buildRunningPipelines, { count: 0, maxLagMs: null }),
      safeAggregate('dataApis', buildDataApiStats, {
        topDataApis: [],
        dataApiTotal: 0,
        publishedDataApis: 0,
      }),
      safeAggregate('dataApiCallStats', buildDataApiCallStats, null),
      safeAggregate('recentAlerts', buildRecentAlerts, []),
      safeAggregate('recentLogs', () => buildRecentLogs(instanceNames), []),
    ]);

  // 7 日成功率：直接复用 recentTrend 的合计，保证与趋势图口径一致
  const weekFinished = recentTrend.reduce((sum, item) => sum + item.success + item.failed, 0);
  const weekSucceeded = recentTrend.reduce((sum, item) => sum + item.success, 0);

  return {
    datasourceTotal,
    taskTotal,
    runningInstances,
    todayTotal: todayInstances.length,
    todaySuccess: countInstancesByStatus(todayInstances, 'success'),
    todayFailed: countInstancesByStatus(todayInstances, 'failed'),
    todayStopped: countInstancesByStatus(todayInstances, 'stopped'),
    recentTrend,
    datasourceTypes,
    taskModeDistribution,
    runningPipelines,
    topDataApis: dataApis.topDataApis,
    dataApiTotal: dataApis.dataApiTotal,
    publishedDataApis: dataApis.publishedDataApis,
    /** 调用明细聚合（契约 1.5），聚合失败时 null（前端按「未下发」处理） */
    dataApiCallStats,
    recentAlerts,
    recentLogs,
    /** 当前 running 实例数（与 runningInstances 同口径：任务 / 数据开发 / 管道实例都在 task_instance 表内） */
    todayRunning: countInstancesByStatus(instances, 'running'),
    /** 近 7 天 success/(success+failed)，0-100 保留 1 位小数，无终态实例为 null */
    weekSuccessRate: weekFinished
      ? Number(((weekSucceeded / weekFinished) * 100).toFixed(1))
      : null,
  };
};

module.exports = {
  FINAL_STATUSES,
  TREND_DAYS,
  TOP_DATAAPI_LIMIT,
  RECENT_ALERT_LIMIT,
  RECENT_LOG_LIMIT,
  isFinalStatus,
  queryInstances,
  queryTaskInstances,
  getInstanceById,
  getInstanceOrThrow,
  getInstanceLogs,
  getInstanceOffsets,
  updateInstance,
  getStatisticsOverview,
  // UTC 日期工具：数据服务调用统计（1.9 recentTrend）与运维大盘共用同一套时间口径
  utcDateOf,
  todayUtcDate,
  recentDates,
};
