/**
 * 清洗汇总任务服务（契约 1.12 §7.2，需求 1「清洗汇总数据指标」）。
 * 物化 SQL 由编译器产物拼装：INSERT INTO 目标表 SELECT 维度+指标聚合 FROM 源表 WHERE 时间/过滤 GROUP BY 维度。
 * 执行走 engine /sql/exec（同步），要求源/目标同数据源（单连接内 INSERT..SELECT，红线 7 同源约束）。
 */
const { paramInvalid, notFound, runningForbidden } = require('../utils/bizError');
const config = require('../config/config');
const logger = require('../config/logger');
const metricTaskRepository = require('../repositories/metrictask.repository');
const metricTaskRunRepository = require('../repositories/metrictaskrun.repository');
const metricModelRepository = require('../repositories/metricmodel.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const metricCompilerService = require('./metricCompiler.service');
const metricExecService = require('./metricExec.service');
const cronMatcher = require('../utils/cronMatcher');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const WRITE_MODES = ['overwrite', 'append', 'upsert'];
const CLEAN_TYPES = ['filter', 'fill', 'rename', 'dedup'];
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

const resolveDateRange = (preset, now = new Date()) => {
  if (!preset) return null;
  if (preset.mode === 'BETWEEN') return { start: preset.start, end: preset.end };
  const days =
    preset.unit === 'MONTH'
      ? 30 * Number(preset.period)
      : preset.unit === 'WEEK'
      ? 7 * Number(preset.period)
      : Number(preset.period);
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
  const rules = Array.isArray(data.cleanRules) ? data.cleanRules : [];
  rules.forEach((rule, index) => {
    if (!CLEAN_TYPES.includes(rule.type)) throw paramInvalid(`cleanRules[${index}].type ∈ ${CLEAN_TYPES.join('|')}`);
    if (rule.type === 'dedup') throw paramInvalid('一期不支持 dedup 规则（MySQL 5.7 无窗口函数），请在上游同步任务去重');
    if (rule.type === 'filter' && !rule.sql) throw paramInvalid(`cleanRules[${index}].sql 必填`);
    if ((rule.type === 'fill' || rule.type === 'rename') && !rule.column)
      throw paramInvalid(`cleanRules[${index}].column 必填`);
  });
  assertTimePreset(data.timePreset);
  if (data.scheduleCron && !cronMatcher.isSupportedCron(data.scheduleCron)) {
    throw paramInvalid('scheduleCron 需为 6 位 Quartz 子集（秒 分 时 日 月 周）');
  }
  const targetTable = String(data.targetTable || '').trim();
  if (!IDENT.test(targetTable)) throw paramInvalid('targetTable 非法（标识符白名单）');
  const status = data.status || 'online';
  if (!['online', 'offline'].includes(status)) throw paramInvalid('status ∈ online|offline');
  return { name, metricIds, writeMode, rules, targetTable, status };
};

/**
 * 组物化计划：全部指标 compileMetricExpr 后必须同 modelId == sourceModelId。
 * @returns {selectItems:[{target,sql}], fromTable, timeColumn, datasourceId, dims:[{target,sql,source,type}], whereExtra, metricCols, dimCols}
 */
const buildPlan = async (task, now = new Date()) => {
  const source = await metricModelRepository.getById(task.sourceModelId);
  if (!source || source.delFlag) throw paramInvalid(`源模型不存在: ${task.sourceModelId}`);
  const fillBy = new Map();
  const renameBy = new Map();
  const filters = [];
  (task.cleanRules || []).forEach((rule) => {
    if (rule.type === 'fill')
      fillBy.set(rule.column, rule.value === undefined || rule.value === null ? '' : String(rule.value));
    if (rule.type === 'rename') renameBy.set(rule.column, rule.to);
    if (rule.type === 'filter') filters.push(rule.sql);
  });

  const modelIds = new Set();
  let timeColumn = '';
  let datasourceId = '';
  const metricItems = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const metricId of task.metricIds) {
    // eslint-disable-next-line no-await-in-loop
    const compiled = await metricCompilerService.compileMetricExpr(metricId);
    modelIds.add(compiled.modelId);
    timeColumn = timeColumn || compiled.timeColumn;
    datasourceId = datasourceId || compiled.datasourceId;
    metricItems.push({ target: compiled.code, sql: compiled.expr, type: typeOfMetric(compiled.expr) });
  }
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

  const dateRange = resolveDateRange(task.timePreset, now);
  return {
    selectItems: [...dimItems, ...metricItems],
    fromTable: source.tableName,
    timeColumn,
    datasourceId,
    dims: dimItems,
    metrics: metricItems,
    filters,
    dateRange,
  };
};

/** 生成执行语句序列（CREATE 目标表 → overwrite 时 TRUNCATE → INSERT..SELECT[ON DUP]） */
const buildStatements = async (task, plan) => {
  const oracle = (await datasourceRepository.getById(task.targetDatasourceId)).type === 'oracle';
  if (oracle && task.writeMode === 'upsert') throw paramInvalid('upsert 仅支持 MySQL（ON DUPLICATE KEY UPDATE）');
  const { dims, metrics } = plan;
  const cols = [...dims.map((d) => d.target), ...metrics.map((m) => m.target), '_etl_time'];
  const selectTail = oracle
    ? dims
        .map((d) => `${d.sql} AS ${d.target}`)
        .concat(
          metrics.map((m) => `${m.sql} AS ${m.target}`),
          ['SYSDATE']
        )
        .join(', ')
    : dims
        .map((d) => `${d.sql} AS \`${d.target}\``)
        .concat(
          metrics.map((m) => `${m.sql} AS \`${m.target}\``),
          ['NOW()']
        )
        .join(', ');
  const whereParts = [...plan.filters.map((f) => `(${f})`)];
  if (plan.dateRange && plan.timeColumn) {
    whereParts.push(`t.${plan.timeColumn} BETWEEN '${plan.dateRange.start}' AND '${plan.dateRange.end}'`);
  }
  const groupBy = dims.length ? ` GROUP BY ${dims.map((d) => d.sql).join(', ')}` : '';
  const selectSql = `SELECT ${selectTail} FROM ${plan.fromTable} t${
    whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
  }${groupBy}`;

  const statements = [];
  if (!task.targetModelId) {
    // 自动目标表：维度列 + 指标列 + _etl_time；upsert 需要维度主键
    const colDefs = [
      ...dims.map((d) => `\`${d.target}\` ${d.type} NOT NULL`),
      ...metrics.map((m) => `\`${m.target}\` ${m.type} NOT NULL DEFAULT 0`),
      '`_etl_time` DATETIME NULL',
    ];
    if (task.writeMode === 'upsert') {
      if (!dims.length) throw paramInvalid('upsert 模式必须配置至少一个维度列作为主键');
      colDefs.push(`PRIMARY KEY (${dims.map((d) => `\`${d.target}\``).join(', ')})`);
    }
    statements.push(
      `CREATE TABLE IF NOT EXISTS \`${task.targetTable}\` (${colDefs.join(
        ', '
      )}) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  }
  if (task.writeMode === 'overwrite') statements.push(`TRUNCATE TABLE \`${task.targetTable}\``);
  const colList = oracle ? cols.map((c) => c.toUpperCase()).join(', ') : cols.map((c) => `\`${c}\``).join(', ');
  let insert = `INSERT INTO ${
    oracle ? task.targetTable.toUpperCase() : `\`${task.targetTable}\``
  } (${colList}) ${selectSql}`;
  if (task.writeMode === 'upsert') {
    insert += ` ON DUPLICATE KEY UPDATE ${metrics
      .map((m) =>
        oracle
          ? `${m.target.toUpperCase()} = VALUES(${m.target.toUpperCase()})`
          : `\`${m.target}\` = VALUES(\`${m.target}\`)`
      )
      .join(', ')}, _etl_time = NOW()`;
  }
  statements.push(insert);
  return statements;
};

/** 计划预览（保存前查看将要执行的语句，不落库不执行） */
const previewPlan = async (data, now = new Date()) => {
  const shape = await validateTaskShape(data);
  const task = { ...data, ...shape };
  const plan = await buildPlan(task, now);
  const statements = await buildStatements(task, plan);
  return { statements, dateRange: plan.dateRange, fromTable: plan.fromTable };
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
    targetDatasourceId: data.targetDatasourceId,
    targetModelId: data.targetModelId || '',
    targetTable: shape.targetTable,
    writeMode: shape.writeMode,
    upsertKeys: Array.isArray(data.upsertKeys) ? data.upsertKeys : [],
    scheduleCron: data.scheduleCron || '',
    status: shape.status,
    remark: data.remark === undefined && existing ? existing.remark : data.remark || '',
    createBy: existing ? existing.createBy : operator,
  };
  // 保存前跑一次计划生成，把配置错误挡在保存期（同源/角色/主键等）
  await buildStatements({ ...payload }, await buildPlan({ ...payload }, new Date()));
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
    const data = await metricExecService.runExec(ds, statements, {
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
  validateTaskShape,
  buildPlan,
  buildStatements,
  previewPlan,
  queryTasks,
  getTask,
  saveTask,
  updateTask,
  deleteTask,
  runTask,
  queryRuns,
  listSchedulable,
};
