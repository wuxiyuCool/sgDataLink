/**
 * 任务运行实例业务层（docs/API.md 第 1.3 节）。
 *
 * 负责实例列表 / 详情 / 日志 / 点位查询，并对外提供实例状态流转 helper，
 * 供 syncTask.service（stop）与 engineReport.service（引擎回报）复用。
 * 另提供 getStatisticsOverview()：运维大盘统计（docs/API.md 第 1.5 节）。
 */
const pick = require('../utils/pick');
const instanceRepository = require('../repositories/instance.repository');
const taskRepository = require('../repositories/task.repository');
const logRepository = require('../repositories/log.repository');
const offsetRepository = require('../repositories/offset.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const { notFound } = require('../utils/bizError');

/** 实例状态终态集合 */
const FINAL_STATUSES = ['success', 'failed', 'stopped'];

/** 运维大盘 recentTrend 的天数（含当天），docs/API.md 1.5 固定 7 天 */
const TREND_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

const isFinalStatus = (status) => FINAL_STATUSES.includes(status);

const getInstanceOrThrow = (id) => {
  const instance = instanceRepository.getById(id);
  if (!instance) {
    throw notFound(`任务实例不存在: ${id}`);
  }
  return instance;
};

/** GET /task-instances —— 支持 taskId / status / trigger / keyword(taskName) / sort */
const queryInstances = (filter = {}, options = {}) => {
  const page = instanceRepository.page({
    filters: { taskId: filter.taskId, status: filter.status, trigger: filter.trigger, pipelineId: filter.pipelineId },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });
  return { ...page, items: page.items.map(withTaskName) };
};

/** GET /tasks/:id/instances —— 某个任务的实例分页 */
const queryTaskInstances = (taskId, options = {}) => {
  if (!taskRepository.getById(taskId)) {
    throw notFound(`同步任务不存在: ${taskId}`);
  }
  return queryInstances({ taskId }, options);
};

/** 实例上补齐 taskName（内存仓储不 join，第二阶段换成 SQL join 后可删） */
const withTaskName = (instance) => {
  if (instance && !instance.taskName) {
    const task = taskRepository.getById(instance.taskId);
    return { ...instance, taskName: task ? task.name : null };
  }
  return instance;
};

/** GET /task-instances/:id */
const getInstanceById = (id) => withTaskName(getInstanceOrThrow(id));

/** GET /task-instances/:id/logs —— 支持 level / keyword / sort */
const getInstanceLogs = (id, filter = {}, options = {}) => {
  const instance = getInstanceOrThrow(id);
  const page = logRepository.page({
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
const getInstanceOffsets = (id, options = {}) => {
  const instance = getInstanceOrThrow(id);
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
 * @returns {Object|null}
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
 * GET /statistics/overview 响应 result。
 * 今日 / 趋势按实例 startedAt 的 UTC 日期聚合，recentTrend 固定 TREND_DAYS 条且日期升序。
 * @returns {Object} { datasourceTotal, taskTotal, runningInstances, todayTotal, todaySuccess,
 *                     todayFailed, todayStopped, recentTrend: [{ date, success, failed }] }
 */
const getStatisticsOverview = () => {
  const instances = instanceRepository.list();
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

  return {
    datasourceTotal: datasourceRepository.count(),
    taskTotal: taskRepository.count(),
    runningInstances: instanceRepository.countByStatus('running'),
    todayTotal: todayInstances.length,
    todaySuccess: countInstancesByStatus(todayInstances, 'success'),
    todayFailed: countInstancesByStatus(todayInstances, 'failed'),
    todayStopped: countInstancesByStatus(todayInstances, 'stopped'),
    recentTrend: Array.from(trendMap.values()),
  };
};

module.exports = {
  FINAL_STATUSES,
  TREND_DAYS,
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
