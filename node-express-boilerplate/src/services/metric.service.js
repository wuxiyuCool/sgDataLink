/**
 * 指标服务（契约 1.12 §6/METRIC-DEV）：三类指标 CRUD、type 规则推导、
 * node-sql-parser 校验（聚合规则/白名单/循环 40905/跨源拒绝）、依赖边重建、保存即版本。
 */
const { Parser } = require('node-sql-parser');
const crypto = require('crypto');
const { paramInvalid, notFound, metricReferenced, metricCycle } = require('../utils/bizError');
const metricRepository = require('../repositories/metric.repository');
const metricDepRepository = require('../repositories/metricdep.repository');
const metricVersionRepository = require('../repositories/metricversion.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const dialect = require('../utils/dialect');

const CODE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const REF_PATTERN = /\$\{([a-z][a-z0-9_]{2,63})\}/g;
const AGG_FUNCTIONS = /\b(SUM|COUNT|AVG|MAX|MIN)\s*\(/i;
// 复合公式标量函数白名单：跨 MySQL/Oracle 常用无副作用标量函数（禁聚合/子查询/表名不变）
const SCALAR_FUNCTIONS = [
  'COALESCE',
  'ROUND',
  'ABS',
  'FLOOR',
  'CEIL',
  'NULLIF',
  'IF',
  'NVL',
  'IFNULL',
  'DECODE',
  'TRUNC',
  'GREATEST',
  'LEAST',
  'MOD',
  'SUBSTR',
  'SUBSTRING',
  'LENGTH',
  'CONCAT',
  'TO_NUMBER',
];
const DEFINED_TYPES = ['MEASURE', 'FIELD', 'METRIC'];
const TIME_UNITS = ['DAY', 'WEEK', 'MONTH'];
const TREE_MAX_DEPTH = 8;

const active = (items) => items.filter((item) => !item.delFlag);

/**
 * 指标涉及的唯一数据源 → 方言（跨源或无源时回落 mysql，只为出提示用）。
 * 语法探针（node-sql-parser）对 mysql/oracle 函数宽容互认，「写得进、跑不了」的写法
 * 只能在保存期按目标方言提示，具体规则表在 utils/dialect。
 */
const resolveMetricDialect = async ({ defineParams, resolved, models }) => {
  const datasourceIds = new Set();
  const modelOf = (metric) => models.find((m) => m.id === (metric.modelId || (metric.defineParams || {}).modelId));
  const selfModel = models.find((m) => m.id === defineParams.modelId);
  if (selfModel) datasourceIds.add(selfModel.datasourceId);
  resolved.forEach((metric) => {
    const model = modelOf(metric);
    if (model) datasourceIds.add(model.datasourceId);
  });
  if (datasourceIds.size !== 1) return dialect.mysql;
  const ds = await datasourceRepository.getById([...datasourceIds][0]);
  if (!ds) return dialect.mysql;
  try {
    return dialect.dialectOfSource(ds);
  } catch (err) {
    // 数据源是 postgresql 等未接入方言：不阻断校验，按默认出提示
    return dialect.mysql;
  }
};

/** 语法探针：把表达式放进 SELECT 里解析，报错即语法非法 */
const assertSqlFragment = (label, sql) => {
  if (!sql || !String(sql).trim()) return;
  try {
    new Parser().astify(`SELECT ${sql} FROM __probe__ t`, 'mysql');
  } catch (err) {
    throw paramInvalid(`${label} 语法错误: ${String(err.message).split('\n')[0]}`);
  }
};

const parseRefs = (expr) => {
  const text = String(expr || '');
  const codes = [...new Set([...text.matchAll(REF_PATTERN)].map((m) => m[1]))];
  // 残留的 ${ 视为非法引用格式（比如拼错的 code）
  const stray = text.replace(REF_PATTERN, '').includes('${');
  if (stray) throw paramInvalid('公式中 ${} 引用格式非法（需匹配 ^[a-z][a-z0-9_]{2,63}$）');
  return codes;
};

/** 复合公式白名单校验：只允许已解析的 ${code} 引用、数字、四则、CASE、标量函数 */
const assertCompositeExpr = (expr, refCount) => {
  const stripped = String(expr || '')
    .replace(REF_PATTERN, ' 1 ')
    .toUpperCase();
  if (/\$\{/.test(stripped)) throw paramInvalid('公式引用未闭合');
  if (AGG_FUNCTIONS.test(stripped)) throw paramInvalid('复合公式禁止聚合函数（聚合来自被引用指标自身）');
  if (/\bFROM\b|\bSELECT\b|\bJOIN\b|;/.test(stripped)) throw paramInvalid('复合公式禁止表名/子查询/多语句');
  const allowed = /^[\s0-9A-Z_.,()+\-*/%<>=]*$/;
  if (!allowed.test(stripped)) {
    const bad = stripped.match(/[^0-9A-Z_.,()+\-*/%<>\s]/);
    throw paramInvalid(`复合公式含非法字符: ${bad ? bad[0] : '?'}`);
  }
  const idents = [
    ...new Set(
      stripped.replace(/(CASE|WHEN|THEN|ELSE|END|AND|OR|NOT|IS|NULL|BETWEEN|LIKE)/g, ' ').match(/\b[A-Z_][A-Z0-9_]*\b/g) ||
        []
    ),
  ];
  const illegal = idents.filter((word) => !SCALAR_FUNCTIONS.includes(word));
  if (illegal.length) throw paramInvalid(`复合公式不允许的标识符: ${illegal.join(', ')}`);
  if (!refCount) throw paramInvalid('复合公式至少要引用 1 个指标');
  assertSqlFragment('复合公式', stripped);
};

/** 时间预设（DERIVED/timePreset） */
const assertTimePreset = (preset) => {
  if (!preset) return;
  if (!['BETWEEN', 'RECENT'].includes(preset.mode)) throw paramInvalid('timePreset.mode ∈ BETWEEN|RECENT');
  if (preset.unit && !TIME_UNITS.includes(preset.unit)) throw paramInvalid(`timePreset.unit ∈ ${TIME_UNITS.join('|')}`);
  if (
    preset.period !== undefined &&
    (!Number.isInteger(Number(preset.period)) || Number(preset.period) < 0 || Number(preset.period) > 3650)
  ) {
    throw paramInvalid('timePreset.period 需为 0~3650 整数');
  }
};

/** 依赖图环检测：从 node 出发沿 children 边，允许回到起点仅当显式判环 */
const assertNoCycle = async (edgesOfNode, startId) => {
  const visited = new Set();
  const walk = (nodeId, path) => {
    if (nodeId === startId && path.length > 1) {
      throw metricCycle(`公式循环依赖: ${path.concat(nodeId).join(' -> ')}`);
    }
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    (edgesOfNode.get(nodeId) || []).forEach((childId) => walk(childId, path.concat(nodeId)));
  };
  walk(startId, []);
};

const deriveType = (defineType, defineParams, refCount) => {
  if (defineType === 'MEASURE' || defineType === 'FIELD') return 'ATOMIC';
  if (defineType === 'METRIC') {
    if (defineParams && defineParams.baseMetricId) {
      if (refCount > 1) throw paramInvalid('派生指标只允许继承单一基底指标；多引用请用 COMPOSITE 公式');
      return 'DERIVED';
    }
    return 'COMPOSITE';
  }
  throw paramInvalid(`defineType ∈ ${DEFINED_TYPES.join('|')}`);
};

const getActiveMetric = async (id) => {
  const metric = await metricRepository.getById(id);
  if (!metric || metric.delFlag) throw notFound(`指标不存在: ${id}`);
  return metric;
};

const findMetricByCode = (metrics, code) => metrics.find((metric) => metric.code === code);

/** 全量校验入口：errors 阻断保存/上线，warnings 只提示（草稿引用草稿等） */
const validateMetric = async (data, selfId = null) => {
  const errors = [];
  const warnings = [];
  const code = String(data.code || '').trim();
  if (!CODE_PATTERN.test(code)) errors.push('code 需匹配 ^[a-z][a-z0-9_]{2,63}$');

  const all = await metricRepository.list();
  const taken = all.find((metric) => metric.code === code && metric.id !== selfId);
  if (taken) errors.push(`code 已被占用（含已删指标，编码终身制）: ${code}(${taken.id})`);

  const { defineType } = data;
  if (!DEFINED_TYPES.includes(defineType)) {
    return { errors: [...errors, `defineType ∈ ${DEFINED_TYPES.join('|')}`], warnings };
  }
  const defineParams = data.defineParams || {};
  const models = active(await metricModelRepository.list());
  let type;
  let refs = [];
  let resolved = [];
  try {
    const refCount = defineType === 'METRIC' ? parseRefs(data.expr).length : 0;
    type = deriveType(defineType, defineParams, refCount);
  } catch (err) {
    return { errors: [...errors, err.message], warnings };
  }

  if (type === 'ATOMIC') {
    const model = models.find((m) => m.id === defineParams.modelId);
    if (!model) {
      errors.push(`ATOMIC 必须挂接有效模型: modelId=${defineParams.modelId || '(空)'}`);
    } else {
      const columns = (await metricModelRepository.getById(model.id)).columns || [];
      if (defineType === 'MEASURE') {
        const col = columns.find((c) => c.columnName === defineParams.measureColumn);
        if (!col) errors.push(`度量字段不在模型列清单: ${defineParams.measureColumn}`);
        else if (col.role !== 'measure') warnings.push(`字段 ${col.columnName} 角色为 ${col.role}，非 measure`);
        if (!['sum', 'count', 'max', 'min', 'avg', 'count_distinct'].includes(defineParams.agg)) {
          errors.push('defineParams.agg ∈ sum|count|max|min|avg|count_distinct');
        }
      } else if (defineType === 'FIELD') {
        if (!data.expr || !AGG_FUNCTIONS.test(String(data.expr))) errors.push('FIELD 模式 expr 必须包含聚合函数');
        try {
          assertSqlFragment('聚合表达式', data.expr);
        } catch (err) {
          errors.push(err.message.replace('参数校验失败: ', ''));
        }
      }
      if (defineParams.filterSql) {
        try {
          assertSqlFragment('过滤条件', `1=1 AND (${defineParams.filterSql})`);
        } catch (err) {
          errors.push(err.message.replace('参数校验失败: ', ''));
        }
      }
      if (defineParams.timeColumn && !columns.some((c) => c.columnName === defineParams.timeColumn)) {
        errors.push(`timeColumn 不在模型列清单: ${defineParams.timeColumn}`);
      }
    }
  }

  if (type === 'DERIVED') {
    const baseCode = parseRefs(data.expr)[0];
    const base =
      findMetricByCode(active(all), defineParams.baseMetricId) || findMetricByCode(all, defineParams.baseMetricId);
    if (!base) errors.push(`基底指标不存在: baseMetricId=${defineParams.baseMetricId}`);
    else {
      if (base.id === selfId) errors.push('基底指标不能是自己');
      if (baseCode && base.code !== baseCode) errors.push(`expr 引用(${baseCode})与 baseMetricId(${base.code})不一致`);
      if (base.status !== 'online') warnings.push(`基底指标状态 ${base.status}，上线前需先行发布`);
      const baseModel = models.find((m) => m.id === base.modelId || m.id === (base.defineParams || {}).modelId);
      if ((defineParams.dimensions || []).length && baseModel) {
        const detail = await metricModelRepository.getById(baseModel.id);
        const usable = (detail.columns || []).filter((c) => ['dimension', 'time'].includes(c.role)).map((c) => c.columnName);
        const illegal = defineParams.dimensions.filter((dim) => !usable.includes(dim));
        if (illegal.length) errors.push(`派生维度越界（基底模型可用: ${usable.join(',') || '无'}）: ${illegal.join(',')}`);
      }
    }
    if (defineParams.filterSql) {
      try {
        assertSqlFragment('业务限定', `1=1 AND (${defineParams.filterSql})`);
      } catch (err) {
        errors.push(err.message.replace('参数校验失败: ', ''));
      }
    }
    try {
      assertTimePreset(defineParams.timePreset);
    } catch (err) {
      errors.push(err.message.replace('参数校验失败: ', ''));
    }
  }

  if (type === 'COMPOSITE') {
    refs = parseRefs(data.expr);
    try {
      assertCompositeExpr(data.expr, refs.length);
    } catch (err) {
      errors.push(err.message.replace('参数校验失败: ', ''));
    }
    resolved = [];
    refs.forEach((ref) => {
      const target = findMetricByCode(all, ref);
      if (!target || target.delFlag) errors.push(`引用的指标不存在: ${ref}`);
      else {
        if (target.id === selfId) errors.push('公式不能引用自身');
        if (target.status !== 'online') warnings.push(`引用指标 ${ref} 状态为 ${target.status}`);
        resolved.push(target);
      }
    });
    // 跨数据源红线：所有引用叶子必须同源（§12.7）
    const dataSources = new Set();
    const collectDs = async (metricId, depth) => {
      if (depth > TREE_MAX_DEPTH) return;
      const metric = await metricRepository.getById(metricId);
      if (!metric) return;
      if (metric.type === 'ATOMIC') {
        const model = models.find((m) => m.id === metric.modelId);
        if (model) dataSources.add(model.datasourceId);
        return;
      }
      const children = await metricDepRepository.childrenOf(metricId);
      await Promise.all(children.map((edge) => collectDs(edge.childId, depth + 1)));
    };
    await Promise.all(resolved.map((metric) => collectDs(metric.id, 1)));
    if (dataSources.size > 1) errors.push(`复合公式跨数据源计算一期禁止（涉及数据源 ${[...dataSources].join(',')}）`);
  }

  // 循环检测（新增指标 selfId 为空时，新边 child 若已可达回自身引用链由已有环兜住）
  if (refs.length || defineParams.baseMetricId) {
    const edgesList = await metricDepRepository.listAll();
    const edgesOfNode = new Map();
    edgesList.forEach((edge) => {
      if (!edgesOfNode.has(edge.parentId)) edgesOfNode.set(edge.parentId, []);
      edgesOfNode.get(edge.parentId).push(edge.childId);
    });
    const childIds = resolved.map((metric) => metric.id);
    if (defineParams.baseMetricId && findMetricByCode(all, defineParams.baseMetricId)) {
      childIds.push(findMetricByCode(all, defineParams.baseMetricId).id);
    }
    childIds.forEach((childId) => {
      if (!edgesOfNode.has(childId)) return;
      const back = (edgesOfNode.get(selfId) || []).concat(childIds);
      edgesOfNode.set(selfId, back);
    });
    if (selfId) {
      try {
        await assertNoCycle(edgesOfNode, selfId);
      } catch (err) {
        errors.push(err.message.replace('参数校验失败: ', ''));
      }
    }
  }

  const dl = await resolveMetricDialect({ defineParams, resolved, models });
  warnings.push(...dl.warnings('公式', data.expr));
  warnings.push(...dl.warnings('过滤条件', defineParams.filterSql));

  return { errors, warnings, type, refs };
};

/** 解析公式引用为依赖边（child 用 id 表达） */
const resolveEdges = async (data) => {
  const all = await metricRepository.list();
  const defineParams = data.defineParams || {};
  const edges = [];
  if (defineParams.baseMetricId) {
    const base = findMetricByCode(all, defineParams.baseMetricId);
    if (base) edges.push({ childId: base.id, refExpr: 'base' });
  }
  if (data.defineType === 'METRIC' && !defineParams.baseMetricId) {
    parseRefs(data.expr).forEach((ref) => {
      const target = findMetricByCode(all, ref);
      if (target) edges.push({ childId: target.id, refExpr: `\${${ref}}` });
    });
  }
  return edges;
};

const snapshot = async (metric, changeNote, operator) => {
  await metricVersionRepository.create({
    metricId: metric.id,
    version: metric.version,
    snapshot: metric,
    changeNote: changeNote || '',
    createBy: operator || '',
  });
};

const buildExprForAtomic = (defineParams) => {
  const { measureColumn, agg } = defineParams;
  if (agg === 'count_distinct') return `COUNT(DISTINCT t.${measureColumn})`;
  if (agg === 'count' && !measureColumn) return 'COUNT(1)';
  return `${String(agg).toUpperCase()}(t.${measureColumn})`;
};

/**
 * 保存主流程：校验（无 error）→ 写指标（type 推导、MEASURE 自动生成 expr）→ 重建依赖边 → 版本快照。
 * body: {code,name,alias,type(不填),defineType,defineParams,expr(FIELD/COMPOSITE 必填),unit,dataFormat,caliber,owner,domainId,status,changeNote}
 */
const saveMetric = async (data, existing = null, operator = '') => {
  const { errors, warnings, type } = await validateMetric(data, existing ? existing.id : null);
  if (errors.length) throw paramInvalid(errors.join('；'));

  const defineParams = { ...(data.defineParams || {}) };
  let expr = data.expr || '';
  if (type === 'ATOMIC' && data.defineType === 'MEASURE') {
    expr = buildExprForAtomic(defineParams);
  }
  if (type === 'DERIVED') {
    const all = await metricRepository.list();
    const base = findMetricByCode(all, defineParams.baseMetricId);
    if (base && !String(expr).trim()) expr = `\${${base.code}}`;
    if (!defineParams.modelId && base) defineParams.modelId = base.modelId || (base.defineParams || {}).modelId || '';
  }

  const payload = {
    code: String(data.code).trim(),
    name: String(data.name).trim(),
    alias: Array.isArray(data.alias) ? data.alias : [],
    type,
    defineType: data.defineType,
    modelId: defineParams.modelId || (existing ? existing.modelId : ''),
    domainId: data.domainId || (existing ? existing.domainId : ''),
    expr,
    defineParams,
    unit: data.unit || (existing ? existing.unit : ''),
    dataFormat: data.dataFormat || (existing ? existing.dataFormat : 'DECIMAL'),
    caliber: data.caliber || (existing ? existing.caliber : ''),
    owner: data.owner || (existing ? existing.owner : ''),
    status: data.status || (existing ? existing.status : 'draft'),
    remark: data.remark === undefined && existing ? existing.remark : data.remark || '',
    createBy: existing ? existing.createBy : operator,
  };

  const record = existing
    ? await metricRepository.update(existing.id, { ...payload, version: (existing.version || 1) + 1 })
    : await metricRepository.create({ ...payload, version: 1 });

  await metricDepRepository.rebuildForParent(record.id, await resolveEdges({ ...data, defineParams, expr }));
  await snapshot(record, data.changeNote, operator);
  return { ...record, warnings };
};

const queryMetrics = (filter = {}, options = {}) =>
  metricRepository.page({
    filters: { ...filter, delFlag: false },
    keyword: options.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const createMetric = (data, operator) => saveMetric(data, null, operator);

const updateMetric = async (id, patch, operator) => {
  const existing = await getActiveMetric(id);
  if (patch.code && patch.code !== existing.code) throw paramInvalid('指标编码 code 创建后不可修改');
  const merged = { ...existing, ...patch, defineParams: patch.defineParams || existing.defineParams };
  return saveMetric(merged, existing, operator);
};

/** 子指标展开树（§6.4）：深度 ≤8，visited 防环 */
const getTree = async (id) => {
  const visited = new Set();
  const build = async (metricId, depth) => {
    const metric = await metricRepository.getById(metricId);
    if (!metric || metric.delFlag) return null;
    const node = {
      id: metric.id,
      code: metric.code,
      name: metric.name,
      type: metric.type,
      defineType: metric.defineType,
      expr: metric.expr,
      status: metric.status,
      modelId: metric.modelId || (metric.defineParams || {}).modelId || '',
      children: [],
    };
    if (depth >= TREE_MAX_DEPTH || visited.has(metricId)) return { ...node, truncated: true };
    visited.add(metricId);
    const edges = await metricDepRepository.childrenOf(metricId);
    const children = await Promise.all(edges.map((edge) => build(edge.childId, depth + 1)));
    node.children = children.filter(Boolean);
    visited.delete(metricId);
    return node;
  };
  await getActiveMetric(id);
  return build(id, 0);
};

const getLineage = async (id) => {
  await getActiveMetric(id);
  const [parents, children] = await Promise.all([metricDepRepository.parentsOf(id), metricDepRepository.childrenOf(id)]);
  const hydrate = async (edges, field) => {
    const nodes = await Promise.all(edges.map((edge) => metricRepository.getById(edge[field])));
    return nodes
      .filter((metric) => metric && !metric.delFlag)
      .map((metric) => ({ id: metric.id, code: metric.code, name: metric.name, type: metric.type, expr: metric.expr }));
  };
  return {
    self: id,
    parents: await hydrate(parents, 'parentId'),
    children: await hydrate(children, 'childId'),
  };
};

/** 删除：被引用 40903；解除自身出边后软删（code 终身不释放） */
const deleteMetric = async (id) => {
  await getActiveMetric(id);
  const parents = await metricDepRepository.parentsOf(id);
  if (parents.length) {
    const names = (await Promise.all(parents.map((edge) => metricRepository.getById(edge.parentId)))).filter(Boolean);
    throw metricReferenced(`指标被 ${names.map((m) => `${m.name}(${m.code})`).join('、')} 引用，禁止删除`);
  }
  await metricDepRepository.removeInvolving(id);
  await metricRepository.update(id, { delFlag: true });
  return { id, deleted: true };
};

const listVersions = async (id) => {
  await getActiveMetric(id);
  return metricVersionRepository.findByMetric(id);
};

/** 回滚=把旧快照内容覆盖当前指标并生成新版本（status 落回 draft 走再上线流程） */
const rollback = async (id, version, operator) => {
  const existing = await getActiveMetric(id);
  const target = await metricVersionRepository.getByVersion(id, version);
  if (!target) throw notFound(`版本不存在: ${id} v${version}`);
  const snapshotData = target.snapshot;
  return saveMetric(
    {
      code: existing.code,
      name: snapshotData.name,
      alias: snapshotData.alias,
      defineType: snapshotData.defineType,
      defineParams: snapshotData.defineParams,
      expr: snapshotData.expr,
      unit: snapshotData.unit,
      dataFormat: snapshotData.dataFormat,
      caliber: snapshotData.caliber,
      owner: snapshotData.owner,
      domainId: snapshotData.domainId,
      status: 'draft',
      changeNote: `回滚自 v${target.version}`,
    },
    existing,
    operator
  );
};

const hashCode = (text) => crypto.createHash('md5').update(String(text)).digest('hex').slice(0, 8);

module.exports = {
  CODE_PATTERN,
  REF_PATTERN,
  AGG_FUNCTIONS,
  SCALAR_FUNCTIONS,
  TREE_MAX_DEPTH,
  active,
  parseRefs,
  assertSqlFragment,
  validateMetric,
  saveMetric,
  queryMetrics,
  createMetric,
  updateMetric,
  getActiveMetric,
  getTree,
  getLineage,
  deleteMetric,
  listVersions,
  rollback,
  hashCode,
};
