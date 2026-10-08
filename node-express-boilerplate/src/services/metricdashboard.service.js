/**
 * 指标中心首页概览（契约 1.12 /metric-dashboard）：实时聚合，无统计表。
 * chat/hotMetrics 两区在 M5 落地，届时替换占位零值。
 */
const metricDomainRepository = require('../repositories/metricdomain.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const metricTaskRepository = require('../repositories/metrictask.repository');
const metricTaskRunRepository = require('../repositories/metrictaskrun.repository');
const metricQueryLogRepository = require('../repositories/metricquerylog.repository');

const active = (items) => items.filter((item) => !item.delFlag);

const groupCount = (items, keyOf) =>
  items.reduce((acc, item) => {
    const key = keyOf(item);
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

const getDashboard = async () => {
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const [domains, models, metrics, tasks, runs, queryLogs] = await Promise.all([
    metricDomainRepository.list(),
    metricModelRepository.list(),
    metricRepository.list(),
    metricTaskRepository.list(),
    metricTaskRunRepository.list(),
    metricQueryLogRepository.recent(since7d, 5000).catch(() => []),
  ]);
  const liveModels = active(models);
  const liveMetrics = active(metrics);
  const liveTasks = active(tasks);
  const dayAgo = Date.now() - 86400000;
  const recentRuns = runs.filter((run) => Date.parse(run.createdAt) >= dayAgo);
  const last24h = {
    success: recentRuns.filter((run) => run.status === 'success').length,
    failed: recentRuns.filter((run) => run.status === 'failed').length,
    running: recentRuns.filter((run) => run.status === 'running').length,
  };
  const finished = last24h.success + last24h.failed;
  // chat/hotMetrics：近 7d 问数日志聚合（metric_ids 冗余列按 id 计数，映射回指标名）
  const metricNameById = new Map(liveMetrics.map((m) => [String(m.id), m.name]));
  const hotCount = {};
  queryLogs.forEach((log) => {
    String(log.metricIds || '')
      .split(',')
      .forEach((id) => {
        const key = id.trim();
        if (!key || !metricNameById.has(key)) return;
        hotCount[key] = (hotCount[key] || 0) + 1;
      });
  });
  const hotMetrics = Object.entries(hotCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({ id, name: metricNameById.get(id), count }));
  return {
    domains: { total: active(domains).length },
    models: {
      total: liveModels.length,
      byLayer: {
        ODS: 0,
        DIM: 0,
        DWD: 0,
        DWS: 0,
        ADS: 0,
        ...groupCount(liveModels, (model) => model.layer),
      },
    },
    metrics: {
      total: liveMetrics.length,
      byType: { ATOMIC: 0, DERIVED: 0, COMPOSITE: 0, ...groupCount(liveMetrics, (m) => m.type) },
      byStatus: { draft: 0, online: 0, offline: 0, ...groupCount(liveMetrics, (m) => m.status) },
    },
    tasks: {
      total: liveTasks.length,
      enabled: liveTasks.filter((task) => task.status === 'online').length,
      last24h,
      successRate: finished ? Math.round((last24h.success / finished) * 1000) / 1000 : 1,
    },
    chat: {
      last7dQueries: queryLogs.length,
      last7dFailed: queryLogs.filter((log) => log.status === 'failed').length,
    },
    hotMetrics,
  };
};

module.exports = { getDashboard };
