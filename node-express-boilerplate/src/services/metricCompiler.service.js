/**
 * 指标语义编译器（契约 1.12 §6.3，本模块自研核心）。
 * 输入 metricId + {dateRange, dimensions[], limit}，输出物理 SQL（不执行；
 * 执行通道 M3 engine /sql/query 落地后接入 preview）。
 *
 * 过滤条件统一编译进聚合的 CASE WHEN 包裹（链上 ATOMIC/DERIVED 各自包一层），
 * WHERE 只留时间范围 —— 这样同表合并与跨表标量两条路径共用一套叶子聚合片段。
 *
 * 路径：
 *  - ATOMIC/DERIVED：单表 SELECT 聚合 [GROUP BY dims]
 *  - COMPOSITE 全叶子同模型：合并单次扫描（${code} 原位替换为聚合片段）
 *  - COMPOSITE 跨模型：标量（无维度）+ 标量子查询拼接；Oracle 补 FROM DUAL；带维度直接拒绝
 */
const { paramInvalid } = require('../utils/bizError');
const metricService = require('./metric.service');
const metricRepository = require('../repositories/metric.repository');
const metricDepRepository = require('../repositories/metricdep.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const datasourceRepository = require('../repositories/datasource.repository');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const AGG_CALL = /^(SUM|COUNT|AVG|MAX|MIN)\((DISTINCT )?(.+)\)$/i;

/**
 * 跨库函数归一：语法探针（node-sql-parser）对方言函数宽容互认，故 Oracle 的 NVL、
 * MySQL 的 IFNULL 能通过校验却会在对方库执行期报「FUNCTION does not exist」。
 * 编译期统一改写成两库都支持的 ANSI COALESCE，用户写法保持不变。
 */
const normalizeDialectFns = (expr) => String(expr || '').replace(/\b(NVL|IFNULL)\s*\(/gi, 'COALESCE(');

/** 聚合表达式套过滤：SUM(t.a) + f → SUM(CASE WHEN f THEN t.a END)；无法安全包裹时原样返回 */
const wrapAggWithFilter = (aggExpr, filterSql) => {
  if (!filterSql || !String(filterSql).trim()) return aggExpr;
  const match = String(aggExpr).trim().match(AGG_CALL);
  if (!match) return aggExpr; // FIELD 手写的复合聚合：保守不包裹（其口径由表达式自身负责）
  const [, fn, distinct, arg] = match;
  return `${fn}(${distinct || ''}CASE WHEN ${filterSql} THEN ${arg.trim()} END)`;
};

const assertDate = (label, value) => {
  if (!DATE_PATTERN.test(String(value || ''))) throw paramInvalid(`${label} 需为 YYYY-MM-DD`);
};

/** 时间过滤（BETWEEN/>=/<=）；列统一加 t. 前缀；oracle=true 时日期包 TO_DATE */
const timeFilter = (timeColumn, dateRange, oracle = false) => {
  if (!dateRange || (!dateRange.start && !dateRange.end)) return null;
  if (!timeColumn) throw paramInvalid('模型未配置时间列，无法按时间范围编译（可在模型上设置 timeColumn）');
  const col = `t.${timeColumn}`;
  // Oracle 日期列不能与裸字符串比较（ORA-01861），须包 TO_DATE；MySQL 用字符串字面量即可
  const lit = (v) => (oracle ? `TO_DATE('${v}','YYYY-MM-DD')` : `'${v}'`);
  if (dateRange.start && dateRange.end) {
    assertDate('dateRange.start', dateRange.start);
    assertDate('dateRange.end', dateRange.end);
    return `${col} BETWEEN ${lit(dateRange.start)} AND ${lit(dateRange.end)}`;
  }
  if (dateRange.start) {
    assertDate('dateRange.start', dateRange.start);
    return `${col} >= ${lit(dateRange.start)}`;
  }
  assertDate('dateRange.end', dateRange.end);
  return `${col} <= ${lit(dateRange.end)}`;
};

const isOracle = async (datasourceId) => {
  if (!datasourceId) return false;
  const ds = await datasourceRepository.getById(datasourceId);
  return Boolean(ds && ds.type === 'oracle');
};

const resolveModel = async (metric) => {
  const modelId = metric.modelId || (metric.defineParams || {}).modelId;
  if (!modelId) throw paramInvalid(`指标 ${metric.code} 未挂接模型，无法编译`);
  const model = await metricModelRepository.getById(modelId);
  if (!model || model.delFlag) throw paramInvalid(`指标 ${metric.code} 的模型不存在: ${modelId}`);
  return model;
};

const assertDimensions = (dimensions, modelColumns, allowed) => {
  const usable = modelColumns.filter((c) => ['dimension', 'time'].includes(c.role)).map((c) => c.columnName);
  const illegal = dimensions.filter((dim) => !usable.includes(dim));
  if (illegal.length) throw paramInvalid(`维度列不在模型（可用: ${usable.join(',') || '无'}）: ${illegal.join(',')}`);
  if (Array.isArray(allowed) && allowed.length) {
    const outScope = dimensions.filter((dim) => !allowed.includes(dim));
    if (outScope.length)
      throw paramInvalid(`派生指标已限定维度（${allowed.join(',')}），请求维度越界: ${outScope.join(',')}`);
  }
};

/**
 * 折叠 ATOMIC/DERIVED 链到单一聚合叶子：
 * {modelId, table, datasourceId, timeColumn, aggExpr(链上全部 filterSql 已 CASE 包裹), allowedDimensions(最严限定)}
 */
const resolveLeaf = async (metricId, visited) => {
  const metric = await metricRepository.getById(metricId);
  if (!metric || metric.delFlag) throw paramInvalid(`依赖的指标不存在: ${metricId}`);
  if (metric.type === 'COMPOSITE') return null;
  const defineParams = metric.defineParams || {};

  if (metric.type === 'DERIVED') {
    if (visited.has(metricId)) throw paramInvalid(`编译循环: ${metric.code}`);
    const edges = await metricDepRepository.childrenOf(metricId);
    const baseEdge = edges.find((edge) => edge.refExpr === 'base') || edges[0];
    if (!baseEdge) throw paramInvalid(`派生指标 ${metric.code} 缺少基底依赖边`);
    const leaf = await resolveLeaf(baseEdge.childId, new Set([...visited, metricId]));
    if (!leaf) throw paramInvalid(`派生指标 ${metric.code} 的基底必须是 ATOMIC/DERIVED`);
    leaf.aggExpr = wrapAggWithFilter(leaf.aggExpr, defineParams.filterSql);
    const ownDims = Array.isArray(defineParams.dimensions) ? defineParams.dimensions : null;
    if (ownDims && ownDims.length) {
      leaf.allowedDimensions = leaf.allowedDimensions
        ? leaf.allowedDimensions.filter((dim) => ownDims.includes(dim))
        : ownDims;
    }
    return leaf;
  }

  const model = await resolveModel(metric);
  return {
    metric,
    modelId: model.id,
    table: model.tableName,
    datasourceId: model.datasourceId,
    timeColumn: defineParams.timeColumn || model.timeColumn || '',
    aggExpr: wrapAggWithFilter(metric.expr || '', defineParams.filterSql),
    columns: model.columns || [],
    allowedDimensions:
      Array.isArray(defineParams.dimensions) && defineParams.dimensions.length ? defineParams.dimensions : null,
  };
};

const emptyScope = () => ({ modelId: null, datasourceId: null, timeColumn: '', dimensionScopes: [] });

// scope 为编译器内部的可变累积对象（非外部入参语义），就地合并
/* eslint-disable no-param-reassign */
const mergeScope = (scope, leaf) => {
  scope.modelId = scope.modelId || leaf.modelId;
  scope.datasourceId = scope.datasourceId || leaf.datasourceId;
  scope.timeColumn = scope.timeColumn || leaf.timeColumn;
  if (leaf.allowedDimensions) scope.dimensionScopes.push(leaf.allowedDimensions);
};
/* eslint-enable no-param-reassign */

/** COMPOSITE 展开为合并聚合表达式（同表路径）；任一叶子跨模型则 expr=null 降级标量路径 */
const expandCompositeExpr = async (metric, visited) => {
  if (visited.has(metric.id)) throw paramInvalid(`编译循环: ${metric.code}`);
  const nextVisited = new Set([...visited, metric.id]);
  const edges = await metricDepRepository.childrenOf(metric.id);
  const children = (await Promise.all(edges.map((edge) => metricRepository.getById(edge.childId)))).filter(
    (child) => child && !child.delFlag
  );
  const byCode = new Map(children.map((child) => [child.code, child]));
  const refs = metricService.parseRefs(metric.expr);
  const missing = refs.filter((code) => !byCode.has(code));
  if (missing.length) throw paramInvalid(`公式引用的指标不在依赖表: ${missing.join(',')}`);

  const scope = emptyScope();
  let expr = normalizeDialectFns(metric.expr);
  // refs 逐个替换且每步读库，必须顺序执行
  // eslint-disable-next-line no-restricted-syntax
  for (const code of refs) {
    const child = byCode.get(code);
    let frag;
    if (child.type === 'COMPOSITE') {
      // eslint-disable-next-line no-await-in-loop
      const inner = await expandCompositeExpr(child, nextVisited);
      if (inner.expr === null) return { expr: null, scope: inner.scope };
      if (scope.modelId && inner.scope.modelId && scope.modelId !== inner.scope.modelId) {
        return { expr: null, scope };
      }
      mergeScope(scope, { ...inner.scope, allowedDimensions: null });
      inner.scope.dimensionScopes.forEach((dimScope) => scope.dimensionScopes.push(dimScope));
      frag = inner.expr;
    } else {
      // eslint-disable-next-line no-await-in-loop
      const leaf = await resolveLeaf(child.id, new Set());
      if (leaf === null) return { expr: null, scope };
      if (scope.modelId && scope.modelId !== leaf.modelId) return { expr: null, scope };
      mergeScope(scope, leaf);
      frag = leaf.aggExpr;
    }
    expr = expr.replace(`\${${code}}`, `(${frag})`);
  }
  return { expr, scope };
};

/** 跨模型标量路径：${code} → 标量子查询；子 COMPOSITE 递归 */
const expandScalarExpr = async (metric, dateRange, visited) => {
  if (visited.has(metric.id)) throw paramInvalid(`编译循环: ${metric.code}`);
  const nextVisited = new Set([...visited, metric.id]);
  const edges = await metricDepRepository.childrenOf(metric.id);
  const children = (await Promise.all(edges.map((edge) => metricRepository.getById(edge.childId)))).filter(
    (child) => child && !child.delFlag
  );
  const byCode = new Map(children.map((child) => [child.code, child]));
  const refs = metricService.parseRefs(metric.expr);
  let datasourceId = null;
  let expr = normalizeDialectFns(metric.expr);
  // eslint-disable-next-line no-restricted-syntax
  for (const code of refs) {
    const child = byCode.get(code);
    if (!child) throw paramInvalid(`公式引用的指标不在依赖表: ${code}`);
    let frag;
    if (child.type === 'COMPOSITE') {
      // eslint-disable-next-line no-await-in-loop
      const inner = await expandScalarExpr(child, dateRange, nextVisited);
      datasourceId = datasourceId || inner.datasourceId;
      // eslint-disable-next-line no-await-in-loop
      const dual = (await isOracle(datasourceId)) ? ' FROM DUAL' : '';
      frag = `(SELECT ${inner.expr} AS metric_value${dual})`;
    } else {
      // eslint-disable-next-line no-await-in-loop
      const leaf = await resolveLeaf(child.id, new Set());
      if (!leaf) throw paramInvalid(`指标 ${code} 无法折叠为聚合叶子`);
      datasourceId = datasourceId || leaf.datasourceId;
      // eslint-disable-next-line no-await-in-loop
      const tf = timeFilter(leaf.timeColumn, dateRange, await isOracle(leaf.datasourceId));
      frag = `(SELECT ${leaf.aggExpr} FROM ${leaf.table} t${tf ? ` WHERE ${tf}` : ''})`;
    }
    expr = expr.replace(`\${${code}}`, frag);
  }
  return { expr, datasourceId };
};

const buildSelect = ({ selectDims, expr, code, table, whereParts, limit, oracle }) => {
  // Oracle 无 LIMIT：12c+ 用 FETCH FIRST n ROWS ONLY（须置于 ORDER BY 之后）
  const limitClause = oracle ? ` FETCH FIRST ${limit} ROWS ONLY` : ` LIMIT ${limit}`;
  return (
    `SELECT ${[...selectDims, `${expr} AS ${code}`].join(', ')} FROM ${table} t` +
    `${whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''}` +
    `${selectDims.length ? ` GROUP BY ${selectDims.join(', ')}` : ''}` +
    `${selectDims.length ? ` ORDER BY ${selectDims.join(', ')}` : ''}${limitClause}`
  );
};

/**
 * 编译入口。preview 与后续 M3 执行、ChatBI 翻译共用此出口。
 * @returns {sql, datasourceId, dialect, modelId?, merged}
 */
const compileMetric = async (metricId, options = {}) => {
  const { dateRange = null, dimensions = [], limit = 1000 } = options;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 100000);
  const metric = await metricService.getActiveMetric(metricId);

  if (metric.type === 'ATOMIC' || metric.type === 'DERIVED') {
    const leaf = await resolveLeaf(metric.id, new Set());
    assertDimensions(dimensions, leaf.columns, leaf.allowedDimensions);
    const ds = await datasourceRepository.getById(leaf.datasourceId);
    const oracle = Boolean(ds && ds.type === 'oracle');
    const sql = buildSelect({
      selectDims: dimensions.map((dim) => `t.${dim}`),
      expr: leaf.aggExpr,
      code: metric.code,
      table: leaf.table,
      whereParts: [timeFilter(leaf.timeColumn, dateRange, oracle)].filter(Boolean),
      limit: safeLimit,
      oracle,
    });
    return {
      sql,
      datasourceId: leaf.datasourceId,
      dialect: ds ? ds.type : 'mysql',
      modelId: leaf.modelId,
      merged: true,
    };
  }

  // COMPOSITE：先试同表合并
  const merged = await expandCompositeExpr(metric, new Set());
  if (merged.expr !== null && merged.scope.modelId) {
    const model = await metricModelRepository.getById(merged.scope.modelId);
    assertDimensions(dimensions, model.columns, null);
    // eslint-disable-next-line no-restricted-syntax
    for (const dimScope of merged.scope.dimensionScopes) {
      assertDimensions(dimensions, model.columns, dimScope);
    }
    const ds = await datasourceRepository.getById(merged.scope.datasourceId);
    const oracle = Boolean(ds && ds.type === 'oracle');
    const sql = buildSelect({
      selectDims: dimensions.map((dim) => `t.${dim}`),
      expr: merged.expr,
      code: metric.code,
      table: model.tableName,
      whereParts: [timeFilter(merged.scope.timeColumn, dateRange, oracle)].filter(Boolean),
      limit: safeLimit,
      oracle,
    });
    return {
      sql,
      datasourceId: merged.scope.datasourceId,
      dialect: ds ? ds.type : 'mysql',
      modelId: merged.scope.modelId,
      merged: true,
    };
  }

  // 跨模型：一期只允许标量（§6.3 规则4）
  if (dimensions.length) {
    throw paramInvalid('跨表复合指标一期仅支持标量查询（不带维度）；同表口径参见 METRIC-DEV §6.3 规则4');
  }
  const scalar = await expandScalarExpr(metric, dateRange, new Set());
  const dual = (await isOracle(scalar.datasourceId)) ? ' FROM DUAL' : '';
  const ds = await datasourceRepository.getById(scalar.datasourceId);
  return {
    sql: `SELECT ${scalar.expr} AS ${metric.code}${dual}`,
    datasourceId: scalar.datasourceId,
    dialect: ds ? ds.type : 'mysql',
    modelId: null,
    merged: false,
  };
};

/**
 * M4 物化内嵌用：把指标编译为「裸聚合表达式 + 作用域」（不拼 SELECT）。
 * 跨模型 COMPOSITE 直接拒绝——清洗任务要求全部指标落在同一源表上。
 * @returns {expr, modelId, datasourceId, timeColumn, dimensionScopes}
 */
const compileMetricExpr = async (metricId) => {
  const metric = await metricService.getActiveMetric(metricId);
  if (metric.type !== 'COMPOSITE') {
    const leaf = await resolveLeaf(metric.id, new Set());
    return {
      expr: leaf.aggExpr,
      modelId: leaf.modelId,
      datasourceId: leaf.datasourceId,
      timeColumn: leaf.timeColumn,
      dimensionScopes: leaf.allowedDimensions ? [leaf.allowedDimensions] : [],
      code: metric.code,
    };
  }
  const merged = await expandCompositeExpr(metric, new Set());
  if (merged.expr === null || !merged.scope.modelId) {
    throw paramInvalid(`跨模型复合指标 ${metric.code} 一期无法物化进同表汇总任务（METRIC-DEV §6.3 规则4）`);
  }
  return { expr: merged.expr, ...merged.scope, code: metric.code };
};

module.exports = {
  DATE_PATTERN,
  wrapAggWithFilter,
  timeFilter,
  resolveLeaf,
  compileMetric,
  compileMetricExpr,
};
