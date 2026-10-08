/**
 * 问数知识库（契约 1.12 M5）：内存索引 + 关键词召回（借 SuperSonic KeywordMapper 思路的简化版）。
 * 索引来源：域 / 模型列（bizName+columnName）/ 指标（name+alias+code）/ 业务术语；
 * 30s TTL 重建，数据量（千级条目）下全量重扫可接受。
 * 向量召回（LLM_EMBED）一期不做开关内实现，接口留 findSimilar 占位扩展。
 */
const metricDomainRepository = require('../repositories/metricdomain.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const metricTermRepository = require('../repositories/metricterm.repository');

const TTL_MS = 30000;
const MIN_MATCH_LEN = 2;

let cache = { builtAt: 0, entries: [] };

const active = (items) => items.filter((item) => !item.delFlag);

const norm = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/\s+/g, '');

const pushEntry = (entries, entry) => {
  const names = [entry.name].concat(entry.aliases || []).filter((n) => n && String(n).trim());
  names.forEach((label) => {
    entries.push({ ...entry, label: norm(label), rawLabel: String(label).trim(), labelLen: norm(label).length });
  });
};

const buildIndex = async ({ force = false } = {}) => {
  if (!force && Date.now() - cache.builtAt < TTL_MS) return cache.entries;
  const [domains, models, metrics, terms] = await Promise.all([
    metricDomainRepository.list(),
    metricModelRepository.list(),
    metricRepository.list(),
    metricTermRepository.list(),
  ]);
  const entries = [];
  active(domains).forEach((domain) => pushEntry(entries, { kind: 'domain', id: domain.id, name: domain.name }));
  const modelById = new Map();
  const modelList = active(models);
  // 列表不带 columns，逐个取详情（模型量级：几十）
  const details = await Promise.all(modelList.map((model) => metricModelRepository.getById(model.id)));
  modelList.forEach((model, i) => {
    const detail = details[i];
    if (!detail) return;
    modelById.set(model.id, detail);
    pushEntry(entries, { kind: 'model', id: model.id, name: model.name, domainId: model.domainId });
    (detail.columns || []).forEach((column) => {
      if (column.role === 'measure') return; // 度量列不直接暴露给问数，走指标
      pushEntry(entries, {
        kind: 'column',
        id: `${model.id}.${column.columnName}`,
        modelId: model.id,
        columnName: column.columnName,
        name: column.bizName || column.columnName,
        aliases: [column.columnName],
        role: column.role,
      });
    });
    if (detail.timeColumn) {
      pushEntry(entries, {
        kind: 'date',
        id: `${model.id}.${detail.timeColumn}`,
        modelId: model.id,
        columnName: detail.timeColumn,
        name: '数据日期',
        aliases: ['日期', '数据日期'],
      });
    }
  });
  active(metrics).forEach((metric) => {
    if (metric.status === 'offline') return;
    const model = modelById.get(metric.modelId || (metric.defineParams || {}).modelId);
    pushEntry(entries, {
      kind: 'metric',
      id: metric.id,
      code: metric.code,
      name: metric.name,
      aliases: metric.alias || [],
      status: metric.status,
      unit: metric.unit,
      caliber: metric.caliber,
      type: metric.type,
      modelName: model ? model.name : '',
      modelId: model ? model.id : '',
    });
  });
  active(terms).forEach((term) =>
    pushEntry(entries, {
      kind: 'term',
      id: term.id,
      name: term.name,
      aliases: term.alias || [],
      description: term.description,
      relatedMetricIds: term.relatedMetricIds || [],
    })
  );
  entries.sort((a, b) => b.labelLen - a.labelLen);
  cache = { builtAt: Date.now(), entries };
  return entries;
};

/** 召回：问题文本对全部词条做最长优先包含匹配；命中越多分越高 */
const recall = async (question) => {
  const entries = await buildIndex();
  const text = norm(question);
  const hits = [];
  const taken = new Set();
  entries.forEach((entry) => {
    if (entry.labelLen < MIN_MATCH_LEN) return;
    if (text.includes(entry.label)) {
      const key = `${entry.kind}:${entry.id}:${entry.label}`;
      if (taken.has(key)) return;
      taken.add(key);
      hits.push(entry);
    }
  });
  const byKind = (kind) => hits.filter((entry) => entry.kind === kind);
  return {
    entries: hits,
    metrics: byKind('metric'),
    columns: [...byKind('column'), ...byKind('date')],
    domains: byKind('domain'),
    models: byKind('model'),
    terms: byKind('term'),
  };
};

/** Prompt 的 schema 段：只给召回集，控制 token 规模 */
const buildSchemaSection = (recallResult) => {
  const metrics = recallResult.metrics
    .slice(0, 15)
    .map(
      (m) =>
        `- ${m.name}(别名:${[...(m.aliases || [])].join('、') || '无'}, 类型:${m.type}${m.unit ? `, 单位:${m.unit}` : ''}${
          m.caliber ? `, 口径:${String(m.caliber).slice(0, 60)}` : ''
        })`
    );
  const columns = recallResult.columns
    .slice(0, 25)
    .map((c) => `- ${c.name}(别名:${[...(c.aliases || [])].join('、') || '无'}, 类型:维度)`);
  const domains = recallResult.domains.map((d) => `- ${d.name}`);
  const terms = recallResult.terms.slice(0, 8).map((t) => `- ${t.name}=${String(t.description || '').slice(0, 120)}`);
  return {
    metrics: metrics.join('\n') || '(本次问题未命中指标)',
    columns: columns.join('\n'),
    domains: domains.join('\n'),
    terms: terms.join('\n'),
  };
};

module.exports = { buildIndex, recall, buildSchemaSection, norm, TTL_MS };
