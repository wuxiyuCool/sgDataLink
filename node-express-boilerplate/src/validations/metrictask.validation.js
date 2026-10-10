const Joi = require('joi');

/** 清洗汇总任务校验（契约 1.12 §7.2）；语义校验（同源/指标角色）在 metricTaskService */

const id = Joi.string().trim().max(64).required();

const cleanRule = Joi.alternatives().try(
  Joi.object().keys({ type: 'filter', sql: Joi.string().trim().max(2000).required() }),
  Joi.object().keys({
    type: 'fill',
    column: Joi.string().trim().max(64).required(),
    value: Joi.string().trim().max(128).allow('', null),
  }),
  Joi.object().keys({
    type: 'rename',
    column: Joi.string().trim().max(64).required(),
    to: Joi.string()
      .trim()
      .pattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .required(),
  }),
  Joi.object().keys({
    type: 'dedup',
    by: Joi.array().items(Joi.string().trim().max(64)).min(1),
    keep: Joi.string().valid('latest', 'first'),
    on: Joi.string().trim().max(64).allow('', null),
  })
);

const baseKeys = {
  name: Joi.string().trim().min(1).max(128),
  domainId: Joi.string().trim().max(64).allow(''),
  sourceModelId: Joi.string().trim().max(64),
  metricIds: Joi.array().items(Joi.string().trim().max(64)).min(1).max(100),
  dimensionColumnIds: Joi.array().items(Joi.string().trim().max(64)).max(50),
  cleanRules: Joi.array().items(cleanRule).max(50),
  timePreset: Joi.object()
    .keys({
      mode: Joi.string().valid('BETWEEN', 'RECENT').required(),
      start: Joi.string()
        .trim()
        .pattern(/^\d{4}-\d{2}-\d{2}$/),
      end: Joi.string()
        .trim()
        .pattern(/^\d{4}-\d{2}-\d{2}$/),
      unit: Joi.string().valid('DAY', 'WEEK', 'MONTH'),
      period: Joi.number().integer().min(1).max(3650),
    })
    .allow(null),
  targetDatasourceId: Joi.string().trim().max(64),
  targetModelId: Joi.string().trim().max(64).allow(''),
  targetTable: Joi.string().trim().max(128).allow(''),
  align: Joi.string().valid('model', 'time').allow(''),
  timeGrain: Joi.string().valid('day', 'week', 'month', 'quarter', 'year').allow(''),
  writeMode: Joi.string().valid('overwrite', 'append', 'upsert'),
  upsertKeys: Joi.array().items(Joi.string().trim().max(64)).max(20),
  scheduleCron: Joi.string().trim().max(64).allow(''),
  status: Joi.string().valid('online', 'offline'),
  remark: Joi.string().trim().max(512).allow('', null),
};

const listTasks = {
  query: Joi.object()
    .keys({
      domainId: Joi.string().trim().max(64),
      status: Joi.string().valid('online', 'offline'),
      lastStatus: Joi.string().valid('idle', 'running', 'success', 'failed'),
      keyword: Joi.string().trim().max(64).allow(''),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const createTask = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      sourceModelId: baseKeys.sourceModelId.required(),
      metricIds: baseKeys.metricIds.required(),
      targetDatasourceId: baseKeys.targetDatasourceId.required(),
      // targetTable 不再硬性必填：选了目标建模表时表名以模型为准（契约 1.15），两者至少要有一个由服务层校验
    })
    .required(),
};

const getTask = { params: Joi.object().keys({ id }) };
const deleteTask = { params: Joi.object().keys({ id }) };
const updateTask = { params: Joi.object().keys({ id }), body: Joi.object().keys(baseKeys).min(1) };

const runTask = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ trigger: Joi.string().valid('manual') })
    .unknown(true),
};

const previewPlan = {
  body: createTask.body.fork(['name', 'sourceModelId', 'metricIds', 'targetDatasourceId', 'targetTable'], (schema) =>
    schema.optional()
  ),
};

const listRuns = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
    })
    .unknown(true),
};

module.exports = { listTasks, getTask, createTask, updateTask, deleteTask, runTask, previewPlan, listRuns };
