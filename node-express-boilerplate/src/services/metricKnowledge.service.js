/**
 * 问数知识库（契约 1.12 M5）：内存索引 + 关键词召回（借 SuperSonic KeywordMapper 思路的简化版）。
 * 索引来源：域 / 模型列（bizName+columnName）/ 指标（name+alias+code）/ 业务术语；
 * 30s TTL 重建，数据量（千级条目）下全量重扫可接受。
 * 向量召回（LLM_EMBED）一期不做开关内实现，接口留 findSimilar 占位扩展。
 */
const { fixMojibake } = require('../utils/mojibake');
const metricDomainRepository = require('../repositories/metricdomain.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const metricTermRepository = require('../repositories/metricterm.repository');
const metricDimService = require('./metricdim.service');

const TTL_MS = 30000;
const MIN_MATCH_LEN = 2;

let cache = { builtAt: 0, entries: [] };
/** 并发重建 single-flight：TTL 过期时同进程只放一次全表扫描 */
let building = null;

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

const buildIndexInner = async () => {
  const [domains, models, metrics, terms, chatConfig] = await Promise.all([
    metricDomainRepository.list(),
    metricModelRepository.list(),
    metricRepository.list(),
    metricTermRepository.list(),
    metricDimService.promptConfig(),
  ]);
  // 候选值是真实业务数据，进 prompt 属数据出境：开关关掉时连档案都不读
  const dimValues = chatConfig.dimValuePrompt ? await metricDimService.valuesByModelId() : new Map();
  const valueTopN = chatConfig.dimValueTopN;
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
      const archived = dimValues.get(`${model.id}.${column.columnName}`) || [];
      pushEntry(entries, {
        kind: 'column',
        id: `${model.id}.${column.columnName}`,
        modelId: model.id,
        columnName: column.columnName,
        name: column.bizName || column.columnName,
        aliases: [column.columnName],
        role: column.role,
        // 候选值：01=华东 这种「库里值=业务名」的写法让 LLM 既能按业务名过滤，也知道真实值长什么样
        values: archived.slice(0, valueTopN).map((item) => (item.label ? `${item.value}=${item.label}` : item.value)),
        valueTotal: archived.length,
      });
      // 取值本身也要能被召回：用户问「华东」时不会提到列名，靠 value 词条把上面的维度列拉进 schema。
      // kind='value' 不参与 toTokens（否则 '华东' 会被换成列 token，WHERE 的字面量就毁了）。
      archived.slice(0, valueTopN).forEach((item) => {
        if (!item.label) return; // 值即业务名的普通维度不必占词条，避免索引被大数据量列撑爆
        pushEntry(entries, {
          kind: 'value',
          id: `${model.id}.${column.columnName}=${item.value}`,
          modelId: model.id,
          columnName: column.columnName,
          columnId: `${model.id}.${column.columnName}`,
          name: item.label,
          aliases: [item.value],
          value: item.value,
        });
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

const buildIndex = async ({ force = false } = {}) => {
  if (!force && Date.now() - cache.builtAt < TTL_MS) return cache.entries;
  if (!building) {
    building = buildIndexInner().finally(() => {
      building = null;
    });
  }
  return building;
};

/** 召回：问题文本对全部词条做包含匹配（词条最长优先） */
const recallWith = (entries, question) => {
  const text = norm(fixMojibake(question));
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
  const valueHits = byKind('value');
  // 同一张表的列会被按「业务名 + 物理列名」展开成多条词条，schema 里只留一条，否则一列刷两行
  const dedupeById = (list) => {
    const seen = new Set();
    return list.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  };
  const columnEntries = dedupeById([...byKind('column'), ...byKind('date')]);
  const columnById = new Map(entries.filter((entry) => entry.kind === 'column').map((entry) => [entry.id, entry]));
  // 用户只说值名（华东）不提列名（region_code）时，靠 value 词条把所属维度列补进 schema —— 否则取值永远进不了 prompt
  valueHits.forEach((hit) => {
    const parent = columnById.get(hit.columnId);
    if (parent && !columnEntries.some((entry) => entry.id === parent.id)) columnEntries.push(parent);
  });
  // 命中指标时把维度清单收敛到「主指标所属的模型」：同名值散在多个模型上（demo 库与业务库都叫华东）
  // 会让 LLM 抓错列，而编译期本来也只允许单模型（多模型直接 clarify），收敛不丢能力只去噪。
  // 主指标取最长命中（「码值订单额」与「订单额」同时命中时以更长者为准，避免子串误召回把别的模型拽进来）。
  const metricHits = byKind('metric')
    .slice()
    .sort((a, b) => b.labelLen - a.labelLen);
  const primary = metricHits.find((entry) => entry.modelId);
  const scoped = primary
    ? columnEntries.filter((entry) => String(entry.modelId) === String(primary.modelId))
    : columnEntries;
  return {
    entries: hits,
    metrics: byKind('metric'),
    // 收敛到空（指标全是不落模型的复合指标）时回退全集，别把维度清单清空
    columns: scoped.length ? scoped : columnEntries,
    values: valueHits,
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
  const columns = recallResult.columns.slice(0, 25).map((c) => {
    const values = c.values || [];
    const more = c.valueTotal > values.length ? `…（另有 ${c.valueTotal - values.length} 种未列出）` : '';
    const valuePart = values.length ? `, 取值:${values.join('、')}${more}` : '';
    return `- ${c.name}(别名:${[...(c.aliases || [])].join('、') || '无'}, 类型:维度${valuePart})`;
  });
  const domains = recallResult.domains.map((d) => `- ${d.name}`);
  const terms = recallResult.terms.slice(0, 8).map((t) => `- ${t.name}=${String(t.description || '').slice(0, 120)}`);
  return {
    metrics: metrics.join('\n') || '(本次问题未命中指标)',
    columns: columns.join('\n'),
    domains: domains.join('\n'),
    terms: terms.join('\n'),
  };
};

const recall = async (question) => recallWith(await buildIndex(), question);

module.exports = { buildIndex, recall, recallWith, buildSchemaSection, norm, TTL_MS };
