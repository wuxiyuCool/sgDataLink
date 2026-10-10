/**
 * 清洗汇总任务服务（契约 1.12 §7.2，需求 1「清洗汇总数据指标」）。
 * 物化 SQL 由编译器产物拼装：INSERT INTO 目标表 SELECT 维度+指标聚合 FROM 源表 WHERE 时间/过滤 GROUP BY 维度。
 * 执行走 engine /sql/exec（同步），要求源/目标同数据源（单连接内 INSERT..SELECT，红线 7 同源约束）。
 */
const { paramInvalid, notFound, runningForbidden } = require('../utils/bizError');
const dialect = require('../utils/dialect');
const config = require('../config/config');
const logger = require('../config/logger');
const metricTaskRepository = require('../repositories/metrictask.repository');
const metricTaskRunRepository = require('../repositories/metrictaskrun.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const metricRepository = require('../repositories/metric.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const metricCompilerService = require('./metricCompiler.service');
const metricExecService = require('./metricExec.service');
const cronMatcher = require('../utils/cronMatcher');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const WRITE_MODES = ['overwrite', 'append', 'upsert'];
const ALIGNS = ['model', 'time'];
const CLEAN_TYPES = ['filter', 'fill', 'rename', 'dedup'];
/** 时间宽表的对齐键列名（也是 upsert 主键）；rename 规则可以用源时间列名改它 */
const STAT_PERIOD = 'stat_period';
const DIM_TARGET_TYPES = {
  BIGINT: 'BIGINT',
  INT: 'INT',
  INTEGER: 'INT',
  SMALLINT: 'SMALLINT',
  TINYINT: 'TINYINT',
  DATE: 'DATE',
  DATETIME: 'DATETIME',
  TIMESTAMP: 'DATETIME',
  TEXT: 'TEXT',
};

const active = (items) => items.filter((item) => !item.delFlag);

const assertTimePreset = (preset) => {
  if (!preset) return;
  if (preset.mode === 'BETWEEN') {
    ['start', 'end'].forEach((k) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(preset[k] || ''))) throw paramInvalid(`timePreset.${k} 需为 YYYY-MM-DD`);
    });
    return;
  }
  if (preset.mode === 'RECENT') {
    if (!['DAY', 'WEEK', 'MONTH'].includes(preset.unit)) throw paramInvalid('timePreset.unit ∈ DAY|WEEK|MONTH');
    if (!Number.isInteger(Number(preset.period)) || Number(preset.period) < 1 || Number(preset.period) > 3650) {
      throw paramInvalid('timePreset.period 需为 1~3650 整数');
    }
    return;
  }
  throw paramInvalid('timePreset.mode ∈ BETWEEN|RECENT');
};

const UNIT_DAYS = { MONTH: 30, WEEK: 7, DAY: 1 };

const resolveDateRange = (preset, now = new Date()) => {
  if (!preset) return null;
  if (preset.mode === 'BETWEEN') return { start: preset.start, end: preset.end };
  const days = (UNIT_DAYS[preset.unit] || 1) * Number(preset.period);
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  return { start, end };
};

const typeOfDim = (dataType) => {
  const t = String(dataType || '').toUpperCase();
  if (DIM_TARGET_TYPES[t]) return DIM_TARGET_TYPES[t];
  const prefix = Object.keys(DIM_TARGET_TYPES).find((k) => t.startsWith(k));
  if (prefix) return DIM_TARGET_TYPES[prefix];
  if (t.startsWith('DECIMAL') || t.startsWith('NUMBER')) return 'DECIMAL(24,6)';
  const len = (t.match(/\d+/) || [64])[0];
  return `VARCHAR(${Math.min(Number(len) || 64, 512)})`;
};

const typeOfMetric = (expr) => (/^COUNT\(/i.test(String(expr).trim()) ? 'BIGINT' : 'DECIMAL(24,6)');

/** 任务配置校验 + 归一（新建与更新共用） */
const validateTaskShape = async (data) => {
  const name = String(data.name || '').trim();
  if (!name) throw paramInvalid('name 必填');
  if (!data.sourceModelId) throw paramInvalid('sourceModelId 必填');
  const metricIds = Array.isArray(data.metricIds) ? data.metricIds : [];
  if (!metricIds.length) throw paramInvalid('metricIds 至少 1 个');
  const writeMode = data.writeMode || 'overwrite';
  if (!WRITE_MODES.includes(writeMode)) throw paramInvalid(`writeMode ∈ ${WRITE_MODES.join('|')}`);
  // 对齐模式（契约 1.15）：model=全部指标同挂一个源模型（可带非时间维度）；time=跨同源模型按时间粒度拼宽表
  const align = data.align || 'model';
  if (!ALIGNS.includes(align)) throw paramInvalid(`align ∈ ${ALIGNS.join('|')}`);
  const timeGrain = data.timeGrain ? String(data.timeGrain).toLowerCase() : '';
  if (align === 'time') {
    if ((data.dimensionColumnIds || []).length) {
      throw paramInvalid('时间宽表只按时间对齐：需要按地区等非时间维度切分请改用同模型模式（align=model）');
    }
    if (!timeGrain) throw paramInvalid(`align=time 必须指定 timeGrain ∈ ${dialect.GRAINS.join('|')}`);
    dialect.grainRank(timeGrain); // 非法档位由方言层给可读报错
  }
  // 目标库方言决定清洗规则与写入模式是否可表达（方言层 §6.4）：Oracle 空串等价 NULL、幂等走 MERGE INTO
  const targetDs = data.targetDatasourceId ? await datasourceRepository.getById(data.targetDatasourceId) : null;
  const dl = dialect.dialectOfSource(targetDs || 'mysql');
  if (writeMode === 'upsert' && !dl.supports.upsert) {
    throw paramInvalid(`${dl.type} 目标不支持 upsert 写入，请改用 overwrite 或 append`);
  }
  const rules = Array.isArray(data.cleanRules) ? data.cleanRules : [];
  rules.forEach((rule, index) => {
    if (!CLEAN_TYPES.includes(rule.type)) throw paramInvalid(`cleanRules[${index}].type ∈ ${CLEAN_TYPES.join('|')}`);
    if (rule.type === 'dedup') throw paramInvalid('一期不支持 dedup 规则（MySQL 5.7 无窗口函数），请在上游同步任务去重');
    if (rule.type === 'filter' && !rule.sql) throw paramInvalid(`cleanRules[${index}].sql 必填`);
    if ((rule.type === 'fill' || rule.type === 'rename') && !rule.column)
      throw paramInvalid(`cleanRules[${index}].column 必填`);
    if (
      rule.type === 'fill' &&
      dl.supports.emptyStringIsNull &&
      (rule.value === undefined || rule.value === null || rule.value === '')
    ) {
      throw paramInvalid(`cleanRules[${index}]: ${dl.type} 中空串等价 NULL，填充值不能为空，请改为实际占位（如 '-'）`);
    }
  });
  assertTimePreset(data.timePreset);
  if (data.scheduleCron && !cronMatcher.isSupportedCron(data.scheduleCron)) {
    throw paramInvalid('scheduleCron 需为 6 位 Quartz 子集（秒 分 时 日 月 周）');
  }
  // 目标建模表（契约 1.15）：表名与数据源以模型为准，任务侧不再自己定表名，也不自动建表/ALTER
  const targetModelId = data.targetModelId || '';
  let targetTable = String(data.targetTable || '').trim();
  if (targetModelId) {
    const targetModel = await metricModelRepository.getById(targetModelId);
    if (!targetModel || targetModel.delFlag) throw paramInvalid(`目标模型不存在: ${targetModelId}`);
    if (targetModel.status === 'draft') {
      throw paramInvalid(`目标模型「${targetModel.name}」是草稿，请先在数据建模页启用`);
    }
    if (targetModel.tableStatus === 'failed') {
      throw paramInvalid(
        `目标模型「${targetModel.name}」的物理表还没建成功（${targetModel.tableMsg || '建表失败'}），请先在建模页重试`
      );
    }
    if (data.targetDatasourceId && String(data.targetDatasourceId) !== String(targetModel.datasourceId)) {
      throw paramInvalid(`目标数据源必须与目标模型的数据源一致（${targetModel.datasourceId}）`);
    }
    targetTable = targetModel.tableName;
  } else if (!targetTable) {
    throw paramInvalid('请选目标建模表（targetModelId），或手工指定 targetTable 走旧的自动建表模式');
  }
  if (!IDENT.test(targetTable)) throw paramInvalid('targetTable 非法（标识符白名单）');
  const status = data.status || 'online';
  if (!['online', 'offline'].includes(status)) throw paramInvalid('status ∈ online|offline');
  return { name, metricIds, writeMode, rules, targetTable, targetModelId, align, timeGrain, status };
};

/** 清洗规则按列名归堆：fill→COALESCE 兜底值，rename→目标列名，filter→原样进 WHERE */
const groupRules = (rules = []) => {
  const fillBy = new Map();
  const renameBy = new Map();
  const filters = [];
  rules.forEach((rule) => {
    if (rule.type === 'fill')
      fillBy.set(rule.column, rule.value === undefined || rule.value === null ? '' : String(rule.value));
    if (rule.type === 'rename') renameBy.set(rule.column, rule.to);
    if (rule.type === 'filter') filters.push(rule.sql);
  });
  return { fillBy, renameBy, filters };
};

/** 逐指标编译为裸聚合表达式（顺序执行：报错要指向第一个越界指标） */
const compileTaskMetrics = async (metricIds) => {
  const items = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const metricId of metricIds) {
    // eslint-disable-next-line no-await-in-loop
    const compiled = await metricCompilerService.compileMetricExpr(metricId);
    items.push({ ...compiled, type: typeOfMetric(compiled.expr) });
  }
  return items;
};

/**
 * 同模型计划（align=model，一期口径）：全部指标同挂 sourceModelId，可按任意维度分组。
 */
const buildModelPlan = async (task, compiled, dateRange) => {
  const source = await metricModelRepository.getById(task.sourceModelId);
  if (!source || source.delFlag) throw paramInvalid(`源模型不存在: ${task.sourceModelId}`);
  // 草稿模型的表结构未确认，不能拿来做物化（契约 1.13）
  if (source.status === 'draft') throw paramInvalid(`源模型「${source.name}」是草稿，请先在数据建模页启用`);
  const { fillBy, renameBy, filters } = groupRules(task.cleanRules);

  const modelIds = new Set(compiled.map((item) => item.modelId));
  const timeColumn = (compiled.find((item) => item.timeColumn) || {}).timeColumn || '';
  const datasourceId = (compiled.find((item) => item.datasourceId) || {}).datasourceId || '';
  const metricItems = compiled.map((item) => ({ target: item.code, sql: item.expr, type: item.type }));
  if (modelIds.size > 1 || (modelIds.size === 1 && !modelIds.has(source.id))) {
    throw paramInvalid(`任务指标必须全部挂在源模型 ${task.sourceModelId} 上（当前涉及 ${[...modelIds].join(',')}）`);
  }
  if (String(task.targetDatasourceId) !== String(datasourceId)) {
    throw paramInvalid('物化要求目标数据源与指标同源（单连接 INSERT..SELECT，契约 1.12 红线）');
  }

  const dimItems = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const columnName of task.dimensionColumnIds || []) {
    const column = (source.columns || []).find((c) => c.columnName === columnName);
    if (!column) throw paramInvalid(`维度列不在源模型: ${columnName}`);
    if (!['dimension', 'time'].includes(column.role)) throw paramInvalid(`列 ${columnName} 不是维度/时间角色`);
    const selectSql = fillBy.has(columnName)
      ? `COALESCE(t.${columnName}, '${fillBy.get(columnName).replace(/'/g, "''")}')`
      : `t.${columnName}`;
    dimItems.push({
      target: renameBy.get(columnName) || columnName,
      sql: selectSql,
      source: columnName,
      type: typeOfDim(column.dataType),
    });
  }

  return {
    align: 'model',
    selectItems: [...dimItems, ...metricItems],
    fromTable: source.tableName,
    fromTables: [source.tableName],
    timeColumn,
    datasourceId,
    dims: dimItems,
    metrics: metricItems,
    filters,
    dateRange,
  };
};

/**
 * 时间宽表计划（align=time，契约 1.15）：指标可跨同源模型，按时间粒度截断对齐。
 * 每个模型一个分组（各自的时间列/表名），唯一的对齐键是截断后的时间（stat_period）。
 */
const buildTimePlan = async (task, compiled, dateRange) => {
  const { fillBy, renameBy, filters } = groupRules(task.cleanRules);
  if (fillBy.size) throw paramInvalid('时间宽表没有可填充的维度列（需要填充兜底值请改用同模型模式，或删掉 fill 规则）');
  const datasourceIds = new Set(compiled.map((item) => String(item.datasourceId)));
  if (datasourceIds.size > 1) {
    throw paramInvalid(`时间宽表要求全部指标同数据源（当前涉及 ${[...datasourceIds].join(',')}）`);
  }
  const { datasourceId } = compiled[0];
  if (String(task.targetDatasourceId) !== String(datasourceId)) {
    throw paramInvalid('物化要求目标数据源与指标同源（单连接 INSERT..SELECT，契约 1.12 红线）');
  }
  // 只能向粗对齐：日→月是再聚合（正确），月→日是无中生有（同一值摊到当月每一天，静默错算）
  const targetRank = dialect.grainRank(task.timeGrain);
  const tooFine = compiled.filter((item) => dialect.grainRank(item.timeGrain) > targetRank);
  if (tooFine.length) {
    throw paramInvalid(
      `目标粒度 ${task.timeGrain} 比指标更细：${tooFine
        .map((item) => `${item.code}(${item.timeGrain})`)
        .join(',')}；请放宽 timeGrain 或把这些指标的源粒度改细`
    );
  }

  const grouped = new Map();
  compiled.forEach((item) => {
    const entry = grouped.get(item.modelId) || { metrics: [], timeColumns: new Set() };
    entry.metrics.push({ target: item.code, sql: item.expr, type: item.type });
    if (item.timeColumn) entry.timeColumns.add(item.timeColumn);
    grouped.set(item.modelId, entry);
  });

  const groups = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const [modelId, entry] of grouped) {
    // eslint-disable-next-line no-await-in-loop
    const model = await metricModelRepository.getById(modelId);
    if (!model || model.delFlag) throw paramInvalid(`源模型不存在: ${modelId}`);
    if (model.status === 'draft') throw paramInvalid(`源模型「${model.name}」是草稿，请先在数据建模页启用`);
    if (entry.timeColumns.size > 1) {
      throw paramInvalid(`模型「${model.name}」内指标的时间列不一致（${[...entry.timeColumns].join(',')}），无法按时间对齐`);
    }
    const timeColumn = [...entry.timeColumns][0] || model.timeColumn || '';
    if (!timeColumn) throw paramInvalid(`模型「${model.name}」未配置时间列，无法按时间对齐`);
    groups.push({
      modelId: model.id,
      modelName: model.name,
      fromTable: model.tableName,
      timeColumn,
      metrics: entry.metrics,
    });
  }

  // 对齐键名：rename 规则只对时间列生效（宽表只有一个对齐键，不给多个目标名）
  const timeColumns = new Set(groups.map((g) => g.timeColumn));
  const outside = [...renameBy.keys()].filter((col) => !timeColumns.has(col));
  if (outside.length) {
    throw paramInvalid(
      `时间宽表只对齐时间列，rename 非时间列无效（可改时间列的目标名，或改用同模型模式）: ${outside.join(',')}`
    );
  }
  const aliases = new Set([...renameBy.values()].map((to) => String(to || '').trim()));
  if (aliases.size > 1) throw paramInvalid('时间宽表只有一个对齐键，rename 时间列不能给出多个目标名');
  const statCol = aliases.size ? [...aliases][0] : STAT_PERIOD;
  if (!IDENT.test(statCol)) throw paramInvalid(`时间列目标名非法（标识符白名单）: ${statCol}`);

  const metrics = groups.reduce((acc, g) => acc.concat(g.metrics), []);
  return {
    align: 'time',
    groups,
    statCol,
    timeGrain: task.timeGrain,
    selectItems: [{ target: statCol, sql: null }, ...metrics],
    fromTable: groups[0].fromTable,
    fromTables: groups.map((g) => g.fromTable),
    timeColumn: groups[0].timeColumn,
    datasourceId,
    dims: [{ target: statCol, sql: null, source: '(时间)', type: 'VARCHAR(32)' }],
    metrics,
    filters,
    dateRange,
  };
};

/**
 * 组物化计划（align 决定形状，契约 1.15 §A）。
 * @returns {{align, selectItems, fromTable, fromTables, timeColumn, datasourceId, dims, metrics, filters, dateRange, groups?, statCol?, timeGrain?}}
 */
const buildPlan = async (task, now = new Date()) => {
  const compiled = await compileTaskMetrics(task.metricIds);
  const dateRange = resolveDateRange(task.timePreset, now);
  if (task.align === 'time') return buildTimePlan(task, compiled, dateRange);
  return buildModelPlan(task, compiled, dateRange);
};

/**
 * 目标建模表是否真有 ETL 留痕列。
 * 表结构权威在建模页（契约 1.15 §C：任务不自动 ALTER），所以留痕列只能「有就写、没有就跳」，
 * 否则每次运行都撞 Unknown column。自动建表的存量任务按二期行为始终带。
 */
const resolveEtlColumn = async (task, dl) => {
  if (!task.targetModelId) return dl.etlColumn;
  const model = await metricModelRepository.getById(task.targetModelId);
  const hit = ((model || {}).columns || []).find((c) => String(c.columnName).toUpperCase() === dl.etlColumn.toUpperCase());
  return hit ? hit.columnName : '';
};

/** 同模型模式：单表 SELECT 聚合（一期形状） */
const buildModelSelect = (plan, dl, etlColumn) => {
  const selectItems = [
    ...plan.dims.map((d) => `${dl.normalize(d.sql)} AS ${dl.ident(d.target)}`),
    ...plan.metrics.map((m) => `${dl.normalize(m.sql)} AS ${dl.ident(m.target)}`),
  ];
  const whereParts = plan.filters.map((f) => `(${dl.normalize(f)})`);
  const timePart = dl.timeFilter(plan.timeColumn, plan.dateRange);
  if (timePart) whereParts.push(timePart);
  // GROUP BY 必须重复表达式：Oracle 不支持 GROUP BY 1/别名
  const groupBy = plan.dims.length ? ` GROUP BY ${plan.dims.map((d) => dl.normalize(d.sql)).join(', ')}` : '';
  if (etlColumn) selectItems.push(`${dl.nowExpr} AS ${dl.ident(etlColumn)}`);
  return {
    cols: [...plan.dims.map((d) => d.target), ...plan.metrics.map((m) => m.target), ...(etlColumn ? [etlColumn] : [])],
    keys: plan.dims.map((d) => d.target),
    selectSql: `SELECT ${selectItems.join(', ')} FROM ${dl.sourceTable(plan.fromTable)} t${
      whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
    }${groupBy}`,
  };
};

/**
 * 时间宽表：每模型一个聚合子查询（时间截断为对齐键），再按「时间全集 LEFT JOIN 各子查询」拼宽。
 * 基表用 UNION 出的时间全集而不是拿某张表当基准——基准表当期无数据时整行会丢（契约 1.15 §A）。
 * MySQL 5.7 无 FULL OUTER JOIN，故两库统一这个形状。
 */
const buildTimeSelect = (plan, dl, etlColumn) => {
  const statCol = dl.ident(plan.statCol);
  const groupAlias = (index) => `dbr_g${index + 1}`;
  const subs = plan.groups.map((group) => {
    const trunc = dl.dateTrunc(`t.${group.timeColumn}`, plan.timeGrain);
    const whereParts = [dl.timeFilter(group.timeColumn, plan.dateRange)]
      .concat(plan.filters.map((f) => `(${dl.normalize(f)})`))
      .filter(Boolean);
    const items = [`${trunc} AS ${statCol}`].concat(
      group.metrics.map((m) => `${dl.normalize(m.sql)} AS ${dl.ident(m.target)}`)
    );
    return `SELECT ${items.join(', ')} FROM ${dl.sourceTable(group.fromTable)} t${
      whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
    } GROUP BY ${trunc}`;
  });
  // 各子查询指标个数不同，UNION 只取对齐键一列（列数必须一致）
  const universe = plan.groups
    .map((group, index) => `SELECT ${statCol} FROM (${subs[index]}) dbr_u${index + 1}`)
    .join(' UNION ');
  const aliasByMetric = new Map();
  plan.groups.forEach((group, index) => {
    group.metrics.forEach((m) => aliasByMetric.set(m.target, groupAlias(index)));
  });
  const selectItems = [`u.${statCol} AS ${statCol}`].concat(
    plan.metrics.map((m) => `${aliasByMetric.get(m.target)}.${dl.ident(m.target)} AS ${dl.ident(m.target)}`)
  );
  if (etlColumn) selectItems.push(`${dl.nowExpr} AS ${dl.ident(etlColumn)}`);
  const joins = plan.groups
    .map(
      (group, index) => ` LEFT JOIN (${subs[index]}) ${groupAlias(index)} ON u.${statCol} = ${groupAlias(index)}.${statCol}`
    )
    .join('');
  return {
    cols: [plan.statCol, ...plan.metrics.map((m) => m.target), ...(etlColumn ? [etlColumn] : [])],
    keys: [plan.statCol],
    selectSql: `SELECT ${selectItems.join(', ')} FROM (${universe}) u${joins}`,
  };
};

/**
 * 生成执行语句序列（自动建表时 CREATE → overwrite 时 TRUNCATE → INSERT..SELECT / MERGE）。
 * 所有方言差异（标识符引用、类型、日期字面量、IF NOT EXISTS、幂等写法）一律问 dialect 层。
 */
const buildStatements = async (task, plan) => {
  const dl = dialect.dialectOfSource(await datasourceRepository.getById(task.targetDatasourceId));
  const etlColumn = await resolveEtlColumn(task, dl);
  const built = plan.align === 'time' ? buildTimeSelect(plan, dl, etlColumn) : buildModelSelect(plan, dl, etlColumn);
  const { cols, keys, selectSql } = built;

  const statements = [];
  if (!task.targetModelId) {
    // 自动目标表（仅存量任务）：维度列 + 指标列 + ETL 时间列；upsert 需要对齐列做主键
    const defs = [
      ...plan.dims.map((d) => `${dl.ident(d.target)} ${dl.columnType(d.type)} NOT NULL`),
      // 指标列允许 NULL：当期没数落 NULL，DEFAULT 0 会被下游读成「真的是零」（契约 1.15 §D）
      ...plan.metrics.map((m) => `${dl.ident(m.target)} ${dl.columnType(m.type)} NULL`),
    ];
    if (etlColumn) defs.push(`${dl.ident(etlColumn)} ${dl.columnType('DATETIME')}`);
    if (task.writeMode === 'upsert') {
      if (!keys.length) throw paramInvalid('upsert 模式必须配置至少一个维度列作为主键');
      defs.push(`PRIMARY KEY (${keys.map((k) => dl.ident(k)).join(', ')})`);
    }
    statements.push(dl.createTable({ table: task.targetTable, defs }));
  }
  if (task.writeMode === 'overwrite') statements.push(dl.clearTarget(task.targetTable));
  if (task.writeMode === 'upsert') {
    statements.push(
      dl.upsertStatement({
        table: task.targetTable,
        columns: cols,
        keys,
        selectSql,
        updateCols: plan.metrics.map((m) => m.target),
        etlColumn,
      })
    );
  } else {
    statements.push(`INSERT INTO ${dl.table(task.targetTable)} (${cols.map((c) => dl.ident(c)).join(', ')}) ${selectSql}`);
  }
  return statements;
};

/** 计划预览（保存前查看将要执行的语句，不落库不执行） */
const previewPlan = async (data, now = new Date()) => {
  const shape = await validateTaskShape(data);
  const task = { ...data, ...shape };
  const plan = await buildPlan(task, now);
  const statements = await buildStatements(task, plan);
  return {
    statements,
    dateRange: plan.dateRange,
    fromTable: plan.fromTable,
    fromTables: plan.fromTables,
    align: plan.align,
    timeGrain: plan.timeGrain || null,
    statCol: plan.statCol || null,
  };
};

const TYPE_CLASS = {
  VARCHAR: 'str',
  CHAR: 'str',
  TEXT: 'str',
  INT: 'num',
  BIGINT: 'num',
  DECIMAL: 'num',
  DATE: 'date',
  DATETIME: 'date',
  TIMESTAMP: 'date',
};

const classOfType = (raw) => TYPE_CLASS[dialect.parseColumnType(raw).family] || 'str';

/**
 * 目标建模表结构比对（契约 1.15 §C）：宽表需要的列必须在模型字段里，类型族要兼容。
 * 只报错不补齐——任务侧不自动建表、不自动 ALTER，否则表结构权威又漏回任务侧。
 * @returns {{model, matched, missingColumns, mismatchColumns}|null} 自动建表的存量任务返回 null
 */
const validateTargetModelShape = async (task, plan) => {
  if (!task.targetModelId) return null;
  const model = await metricModelRepository.getById(task.targetModelId);
  if (!model || model.delFlag) throw paramInvalid(`目标模型不存在: ${task.targetModelId}`);
  const byName = new Map((model.columns || []).map((c) => [String(c.columnName).toUpperCase(), c]));
  const need = [
    ...plan.dims.map((d) => ({ name: d.target, type: d.type, kind: '维度' })),
    ...plan.metrics.map((m) => ({ name: m.target, type: m.type, kind: '指标' })),
  ];
  const missingColumns = [];
  const mismatchColumns = [];
  need.forEach((col) => {
    const actual = byName.get(String(col.name).toUpperCase());
    if (!actual) {
      missingColumns.push({ name: col.name, kind: col.kind, suggestType: col.type });
      return;
    }
    if (classOfType(actual.dataType) !== classOfType(col.type)) {
      mismatchColumns.push({ name: col.name, kind: col.kind, expected: col.type, actual: actual.dataType });
    }
  });
  return {
    model,
    matched: !missingColumns.length && !mismatchColumns.length,
    missingColumns,
    mismatchColumns,
  };
};

/** 结构不符时的可读拒因（保存期 40001；结构化清单由 target-schema 回显给界面） */
const describeTargetGap = (check) => {
  const parts = [];
  if (check.missingColumns.length)
    parts.push(`目标建模表缺列：${check.missingColumns.map((c) => `${c.name}(${c.suggestType})`).join('、')}`);
  if (check.mismatchColumns.length)
    parts.push(
      `列类型不兼容：${check.mismatchColumns.map((c) => `${c.name} 需要 ${c.expected}，表上是 ${c.actual}`).join('、')}`
    );
  return `${parts.join('；')}。请到「数据建模」页给目标模型补列/改类型（任务不会自动 ALTER）`;
};

/**
 * 目标表结构预览（界面「选了哪些维度/指标 → 会建成什么样」的权威口径）。
 * 字段与类型都取自 buildPlan + 方言层，前端不再自己猜；不落库、不执行。
 */
const previewTargetSchema = async (data, now = new Date()) => {
  const shape = await validateTaskShape(data);
  const task = { ...data, ...shape };
  const plan = await buildPlan(task, now);
  const ds = await datasourceRepository.getById(task.targetDatasourceId);
  const dl = dialect.dialectOfSource(ds);
  const check = await validateTargetModelShape(task, plan);
  const etlColumn = await resolveEtlColumn(task, dl);
  const [model, metrics] = await Promise.all([metricModelRepository.getById(task.sourceModelId), metricRepository.list()]);
  const bizBy = new Map(((model || {}).columns || []).map((c) => [c.columnName, c.bizName || '']));
  const nameBy = new Map(active(metrics).map((m) => [m.code, m.name]));
  const columns = [
    ...plan.dims.map((d) => ({
      name: dl.ident(d.target).replace(/`/g, ''),
      type: dl.columnType(d.type),
      source: plan.align === 'time' ? '时间' : '维度',
      comment: plan.align === 'time' ? `${plan.timeGrain} 粒度对齐键` : bizBy.get(d.source) || '',
    })),
    ...plan.metrics.map((m) => ({
      name: dl.ident(m.target).replace(/`/g, ''),
      type: dl.columnType(m.type),
      source: '指标',
      comment: nameBy.get(m.target) || '',
    })),
  ];
  if (etlColumn) {
    columns.push({
      name: dl.ident(etlColumn).replace(/`/g, ''),
      type: dl.columnType('DATETIME'),
      source: '留痕',
      comment: '本次物化时间（系统列）',
    });
  }
  const statements = await buildStatements(task, plan);
  const built = plan.align === 'time' ? buildTimeSelect(plan, dl, etlColumn) : buildModelSelect(plan, dl, etlColumn);
  return {
    dialect: dl.type,
    table: task.targetTable,
    autoCreate: !task.targetModelId,
    align: plan.align,
    timeGrain: plan.timeGrain || null,
    groups: plan.groups || [],
    writeMode: task.writeMode,
    primaryKeys: task.writeMode === 'upsert' ? built.keys : [],
    targetModel: check ? { id: check.model.id, name: check.model.name, tableStatus: check.model.tableStatus || '' } : null,
    matched: check ? check.matched : true,
    missingColumns: check ? check.missingColumns : [],
    mismatchColumns: check ? check.mismatchColumns : [],
    columns,
    createSql: statements.find((sql) => /^CREATE TABLE/i.test(sql)) || null,
    insertSql: statements.find((sql) => /^(INSERT INTO|MERGE INTO)/i.test(sql)) || null,
  };
};

/** 保存期结构闸门：目标建模表缺列/类型不符直接 40001 */
const assertTargetModelShape = async (task) => {
  const plan = await buildPlan(task, new Date());
  const check = await validateTargetModelShape(task, plan);
  if (check && !check.matched) throw paramInvalid(describeTargetGap(check));
  return plan;
};

const queryTasks = (filter = {}, options = {}) =>
  metricTaskRepository.page({
    filters: { ...filter, delFlag: false },
    keyword: options.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getTask = async (id) => {
  const task = await metricTaskRepository.getById(id);
  if (!task || task.delFlag) throw notFound(`指标任务不存在: ${id}`);
  return task;
};

const getTaskModel = async (modelId) => {
  const model = await metricModelRepository.getById(modelId);
  if (!model || model.delFlag) throw paramInvalid(`源模型不存在: ${modelId}`);
  return model;
};

const saveTask = async (data, existing = null, operator = '') => {
  const shape = await validateTaskShape(data);
  await getTaskModel(data.sourceModelId);
  const ds = await datasourceRepository.getById(data.targetDatasourceId);
  if (!ds || ds.status === 'disabled') throw paramInvalid(`目标数据源不存在或已禁用: ${data.targetDatasourceId}`);
  const payload = {
    name: shape.name,
    domainId: data.domainId || '',
    sourceModelId: data.sourceModelId,
    metricIds: shape.metricIds,
    dimensionColumnIds: Array.isArray(data.dimensionColumnIds) ? data.dimensionColumnIds : [],
    cleanRules: shape.rules,
    timePreset: data.timePreset || null,
    align: shape.align,
    timeGrain: shape.timeGrain || '',
    targetDatasourceId: data.targetDatasourceId,
    targetModelId: shape.targetModelId,
    targetTable: shape.targetTable,
    writeMode: shape.writeMode,
    upsertKeys: Array.isArray(data.upsertKeys) ? data.upsertKeys : [],
    scheduleCron: data.scheduleCron || '',
    status: shape.status,
    remark: data.remark === undefined && existing ? existing.remark : data.remark || '',
    createBy: existing ? existing.createBy : operator,
  };
  // 保存前跑一次计划生成，把配置错误挡在保存期（同源/角色/粒度/主键等）
  await buildStatements({ ...payload }, await buildPlan({ ...payload }, new Date()));
  // 目标建模表结构比对（契约 1.15 §C）：缺列/类型不符只报错，界面走 target-schema 拿结构化清单
  await assertTargetModelShape({ ...payload });
  if (existing) return metricTaskRepository.update(existing.id, payload);
  return metricTaskRepository.create(payload);
};

const updateTask = async (id, patch, operator) => {
  const existing = await getTask(id);
  if (
    patch.scheduleCron &&
    patch.scheduleCron !== existing.scheduleCron &&
    !cronMatcher.isSupportedCron(patch.scheduleCron)
  ) {
    throw paramInvalid('scheduleCron 需为 6 位 Quartz 子集');
  }
  const merged = { ...existing, ...patch };
  return saveTask(merged, existing, operator);
};

const deleteTask = async (id) => {
  const task = await getTask(id);
  if (task.lastStatus === 'running') throw runningForbidden('任务正在执行中，禁止删除');
  await metricTaskRepository.update(id, { delFlag: true });
  return { id, deleted: true };
};

/**
 * 执行任务：组语句 → engine /sql/exec（同步）→ 落 run 记录 + 回写任务状态。
 * 失败写 run(failed) + 触发告警（condition=task_failed, targetType=metrictask）。
 */
const runTask = async (id, trigger = 'manual') => {
  if (config.db.driver !== 'mysql') throw paramInvalid('清洗汇总任务需要 DB_DRIVER=mysql 真实执行（内存模式不物化）');
  const task = typeof id === 'object' ? id : await getTask(id);
  const live = await metricTaskRepository.getById(task.id);
  if (live.lastStatus === 'running') throw runningForbidden('任务正在执行中');
  const now = new Date();
  const plan = await buildPlan(live, now);
  const statements = await buildStatements(live, plan);
  const ds = await datasourceRepository.getById(live.targetDatasourceId);
  // 方言层没有 IF NOT EXISTS 的库（Oracle 12cR2 前）：先探数据字典，表已存在则跳过建表语句（幂等）
  let execStatements = statements;
  const probeSql = dialect.dialectOfSource(ds).tableExistsProbe(live.targetTable);
  if (probeSql && execStatements.length && /^CREATE TABLE/i.test(execStatements[0])) {
    const probe = await metricExecService.runSql(live.targetDatasourceId, probeSql);
    if (Number(((probe.rows || [])[0] || [])[0]) > 0) execStatements = execStatements.slice(1);
  }
  const run = await metricTaskRunRepository.create({
    taskId: live.id,
    trigger,
    status: 'running',
    sqlText: statements.join('\n-- \n'),
    createdAt: now.toISOString(),
  });
  await metricTaskRepository.update(live.id, { lastStatus: 'running', lastRunAt: now.toISOString() });

  const startedAt = Date.now();
  try {
    const data = await metricExecService.runExec(ds, execStatements, {
      instanceId: run.id,
      timeoutMs: Math.max(config.engine.sqlTimeoutMs, 600000),
    });
    const insertResult = (data.results || []).slice(-1)[0] || {};
    const writeRows = Number(insertResult.affectedRows || 0);
    const finishedAt = new Date().toISOString();
    await metricTaskRunRepository.update(run.id, {
      status: 'success',
      writeRows,
      elapsedMs: Date.now() - startedAt,
      message: null,
    });
    await metricTaskRepository.update(live.id, { lastStatus: 'success', lastRunAt: finishedAt });
    return { taskId: live.id, runId: run.id, status: 'success', writeRows, statements: statements.length };
  } catch (err) {
    const message = String(err.message || err).slice(0, 1000);
    await metricTaskRunRepository.update(run.id, { status: 'failed', elapsedMs: Date.now() - startedAt, message });
    await metricTaskRepository.update(live.id, { lastStatus: 'failed', lastRunAt: new Date().toISOString() });
    // 告警：task_failed 条件（scope=all 或含 metrictask 的规则命中）
    // eslint-disable-next-line global-require
    const alertService = require('./alert.service');
    alertService
      .fireEvent({
        condition: 'task_failed',
        targetType: 'metrictask',
        targetId: live.id,
        targetName: live.name,
        message: `指标清洗任务失败: ${message}`,
      })
      .catch((e) => logger.warn('metrictask alert fire failed: %s', e.message));
    throw err;
  }
};

const queryRuns = (taskId, options = {}) =>
  metricTaskRunRepository.page({
    filters: { taskId },
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

/** 调度器扫描入口（scheduler.service 每秒分支调用） */
const listSchedulable = async () =>
  active(await metricTaskRepository.list()).filter((t) => t.status === 'online' && t.scheduleCron);

module.exports = {
  WRITE_MODES,
  ALIGNS,
  STAT_PERIOD,
  validateTaskShape,
  buildPlan,
  buildStatements,
  validateTargetModelShape,
  previewPlan,
  previewTargetSchema,
  queryTasks,
  getTask,
  saveTask,
  updateTask,
  deleteTask,
  runTask,
  queryRuns,
  listSchedulable,
};
