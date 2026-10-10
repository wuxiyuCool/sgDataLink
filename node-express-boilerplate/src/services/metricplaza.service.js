/**
 * 指标广场（契约 1.14 / V11 二期）：按域分节的浏览聚合 + 从表批量生成指标。
 * 只读聚合，不改 /metrics 的分页语义；热度口径与首页 dashboard 一致（近 7d query_log 的 metric_ids）。
 */
const { paramInvalid } = require('../utils/bizError');
const metricRepository = require('../repositories/metric.repository');
const metricDomainRepository = require('../repositories/metricdomain.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricDepRepository = require('../repositories/metricdep.repository');
const metricQueryLogRepository = require('../repositories/metricquerylog.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const metricService = require('./metric.service');

const PLAZA_LIMIT_MAX = 500;
const PLAZA_DEFAULT_LIMIT = 500;
const HOT_WINDOW_MS = 7 * 86400000;
const BATCH_MAX = 50;

const active = (items) => items.filter((item) => !item.delFlag);

/** 命中口径与列表页一致（name/code/alias），广场额外搜口径，因为卡片上就展示 caliber */
const matchesKeyword = (metric, text) => {
  if (!text) return true;
  const hay = [metric.name, metric.code, ...(metric.alias || [])].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(text.toLowerCase());
};

/** 根域的 parentId 在库里存的是字符串 '0'（不是空串），两种写法都当成"没有父节点" */
const parentOf = (domain) => {
  const text = String(domain.parentId === undefined || domain.parentId === null ? '' : domain.parentId);
  return !text || text === '0' ? '' : text;
};

/** 域树里某节点的全部后代 id（含自身）；父指针成环时靠 seen 兜底不死循环 */
const subtreeIds = (domains, rootId) => {
  const childrenBy = new Map();
  active(domains).forEach((domain) => {
    const parent = parentOf(domain);
    if (!parent) return;
    if (!childrenBy.has(parent)) childrenBy.set(parent, []);
    childrenBy.get(parent).push(domain.id);
  });
  const collected = [];
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    if (!seen.has(id)) {
      seen.add(id);
      collected.push(id);
      (childrenBy.get(id) || []).forEach((child) => queue.push(child));
    }
  }
  return collected;
};

/** 沿 parentId 上溯到根域，返回 {root, path}（path 用于卡片面包屑「交易演示/支付域」） */
const locateRoot = (byId, domainId) => {
  const path = [];
  let node = byId.get(String(domainId || ''));
  const seen = new Set();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    path.unshift(node.name);
    const parent = parentOf(node);
    if (!parent) return { root: node, path };
    node = byId.get(parent);
  }
  return null; // 悬空 parentId：该指标不进任何分节，由调用方计数
};

/**
 * GET /metrics/plaza
 * filter: {domainId?, type?, status?, keyword?, limit?}；status 缺省只回 online（广场=上架目录）
 */
const getPlaza = async (filter = {}) => {
  const limit = Math.min(Math.max(parseInt(filter.limit, 10) || PLAZA_DEFAULT_LIMIT, 1), PLAZA_LIMIT_MAX);
  const [domains, metrics, models, edges, queryLogs, datasources] = await Promise.all([
    metricDomainRepository.list(),
    metricRepository.list(),
    metricModelRepository.list(),
    metricDepRepository.listAll().catch(() => []),
    metricQueryLogRepository.recent(new Date(Date.now() - HOT_WINDOW_MS).toISOString(), 5000).catch(() => []),
    datasourceRepository.list().catch(() => []),
  ]);
  const byId = new Map(active(domains).map((domain) => [String(domain.id), domain]));
  const modelNameById = new Map(active(models).map((model) => [String(model.id), model.name]));
  // 卡片带数据源：界面据此判断「勾选的指标跨数据源」——时间宽表要求同源，提前拦住比保存期报错友好
  const dsIdByModel = new Map(active(models).map((model) => [String(model.id), String(model.datasourceId || '')]));
  const dsNameById = new Map(active(datasources).map((ds) => [String(ds.id), ds.name]));
  // 被引用数：dep 边 child_id 出现次数（parent 引用 child，所以 child 才是"被引用"的一方）
  const referencedBy = new Map();
  active(edges).forEach((edge) => {
    const key = String(edge.childId);
    referencedBy.set(key, (referencedBy.get(key) || 0) + 1);
  });
  const metricIds = new Set(active(metrics).map((metric) => String(metric.id)));
  const hot7d = new Map();
  queryLogs.forEach((log) => {
    String(log.metricIds || '')
      .split(',')
      .forEach((raw) => {
        const key = raw.trim();
        if (!key || !metricIds.has(key)) return;
        hot7d.set(key, (hot7d.get(key) || 0) + 1);
      });
  });

  const wanted = String(filter.status || 'online').toLowerCase();
  const statusOk = (metric) => {
    if (wanted === 'all') return true;
    if (wanted === 'online') return metric.status === 'online';
    return metric.status === wanted;
  };
  const scoped = filter.domainId ? new Set(subtreeIds(domains, String(filter.domainId))) : null;
  const keyword = String(filter.keyword || '').trim();

  const sections = new Map();
  let total = 0;
  active(metrics).forEach((metric) => {
    if (filter.type && metric.type !== filter.type) return;
    if (!statusOk(metric)) return;
    if (!matchesKeyword(metric, keyword)) return;
    if (scoped && !scoped.has(String(metric.domainId))) return;
    const located = locateRoot(byId, metric.domainId);
    if (!located) return;
    if (!sections.has(located.root.id)) {
      sections.set(located.root.id, {
        id: located.root.id,
        name: located.root.name,
        code: located.root.code,
        path: located.path,
        items: [],
      });
    }
    total += 1;
    const id = String(metric.id);
    const cardModelId = String(metric.modelId || (metric.defineParams || {}).modelId || '');
    const cardDsId = dsIdByModel.get(cardModelId) || '';
    sections.get(located.root.id).items.push({
      id,
      code: metric.code,
      name: metric.name,
      alias: metric.alias || [],
      type: metric.type,
      status: metric.status,
      unit: metric.unit || '',
      dataFormat: metric.dataFormat || '',
      caliber: metric.caliber || '',
      owner: metric.owner || '',
      domainId: metric.domainId,
      domainPath: located.path,
      modelId: cardModelId,
      modelName: modelNameById.get(cardModelId) || '',
      datasourceId: cardDsId,
      datasourceName: dsNameById.get(cardDsId) || '',
      referencedBy: referencedBy.get(id) || 0,
      hot7d: hot7d.get(id) || 0,
      updatedAt: metric.updatedAt,
    });
  });

  const sortCard = (a, b) => b.hot7d - a.hot7d || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  let kept = 0;
  const list = [...sections.values()]
    .map((section) => {
      const items = section.items.sort(sortCard);
      return { ...section, total: items.length, items };
    })
    .sort((a, b) => b.total - a.total);
  const grouped = [];
  list.forEach((section) => {
    if (kept >= limit) return;
    const items = section.items.slice(0, limit - kept);
    kept += items.length;
    if (items.length) grouped.push({ ...section, items });
  });
  return { domains: grouped, total, truncated: total > kept, limit };
};

/**
 * 批量项是「列 → 指标」的扁平形态（界面一行一列），这里折算成单条创建契约的 defineParams 形态；
 * 语义校验（聚合规则/循环/跨源/草稿模型闸门）全部交给 createMetric，一处闸门不复制两份。
 */
const toMetricPayload = (item) => {
  const defineParams = {
    modelId: item.modelId,
    measureColumn: item.measureColumn,
    agg: item.agg,
  };
  if (item.timeColumn) defineParams.timeColumn = item.timeColumn;
  if (item.filterSql) defineParams.filterSql = item.filterSql;
  return {
    code: item.code,
    name: item.name,
    alias: item.alias,
    domainId: item.domainId,
    unit: item.unit,
    dataFormat: item.dataFormat,
    caliber: item.caliber,
    owner: item.owner,
    remark: item.remark,
    status: item.status || 'online',
    defineType: 'MEASURE',
    defineParams,
  };
};

/**
 * POST /metrics/batch：逐条走单条 createMetric。
 * 顺序执行——同批内后一条可以引用前一条，重复 code 也会被第二条拦下。
 * 无事务：部分成功是常态（界面按条显示），所以 HTTP 层恒成功，成败写在 results 里。
 */
const createMetricsBatch = async (items = [], operator = '') => {
  if (!Array.isArray(items) || !items.length) throw paramInvalid('items 不能为空');
  if (items.length > BATCH_MAX) throw paramInvalid(`单次批量创建上限 ${BATCH_MAX} 条，请分批提交`);
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    try {
      // 顺序执行是刻意的：后一条要能引用前一条，同批重复 code 也要被第二条拦住
      // eslint-disable-next-line no-await-in-loop
      const created = await metricService.createMetric(toMetricPayload(item), operator);
      results.push({ index, code: item.code, ok: true, id: created.id, name: created.name });
    } catch (err) {
      results.push({ index, code: item.code, ok: false, message: String(err.message || err).slice(0, 300) });
    }
  }
  return {
    results,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
};

module.exports = {
  getPlaza,
  createMetricsBatch,
  toMetricPayload,
  subtreeIds,
  locateRoot,
  matchesKeyword,
  PLAZA_LIMIT_MAX,
  BATCH_MAX,
};
