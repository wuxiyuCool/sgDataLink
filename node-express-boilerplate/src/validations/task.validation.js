const Joi = require('joi');

/**
 * 同步任务校验（docs/API.md 第 1.2 节）。
 * incremental 模式必须给 incrementalColumn：这里用 when 做首轮拦截，
 * service 再兜一次底并返回 40001 的中文提示。
 *
 * 对标 FineDataLink 的增量字段：
 * - scheduleCron / retryCount / retryIntervalSec：调度配置，Mock 阶段只校验与存取，不触发真实调度；
 * - fieldMappings[].transform：转换组件占位，type=constant|expression 时 value 必填非空。
 */

const SYNC_MODES = ['full', 'incremental'];
const WRITE_MODES = ['insert', 'upsert', 'overwrite'];
const LAST_STATUSES = ['idle', 'running', 'success', 'failed', 'stopped'];
/** fieldMappings[].transform.type 取值（对标 FDL 转换组件占位，Mock 阶段仅存储回显） */
const TRANSFORM_TYPES = ['none', 'upper', 'lower', 'trim', 'constant', 'expression'];
/** 需要 value 非空的 transform 类型，其余类型 value 可为 null / 缺省 */
const TRANSFORM_TYPES_WITH_VALUE = ['constant', 'expression'];

/**
 * transform 结构：{ type, value }。
 * type=constant|expression 时 value 必填非空；none|upper|lower|trim 时 value 可缺省 / 为 null。
 * 用 Joi.any().when() 做分支：命中条件时完全采用 then/otherwise 里的 string 规则。
 */
const transform = Joi.object().keys({
  type: Joi.string().valid(...TRANSFORM_TYPES).required(),
  value: Joi.any().when('type', {
    is: Joi.string().valid(...TRANSFORM_TYPES_WITH_VALUE).required(),
    then: Joi.string().trim().min(1).max(500).required(),
    otherwise: Joi.string().trim().max(500).allow('', null),
  }),
});

const id = Joi.string().trim().max(64).required();

const fieldMapping = Joi.object().keys({
  sourceField: Joi.string().trim().max(128).required(),
  targetField: Joi.string().trim().max(128).required(),
  sourceType: Joi.string().trim().max(64).allow('', null),
  targetType: Joi.string().trim().max(64).allow('', null),
  primaryKey: Joi.boolean(),
  // 契约：transform 为 null 表示不做转换，因此允许显式 null
  transform: transform.allow(null),
});

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  syncMode: Joi.string().valid(...SYNC_MODES),
  sourceId: Joi.string().trim().max(64),
  sourceTable: Joi.string().trim().max(128),
  targetId: Joi.string().trim().max(64),
  targetTable: Joi.string().trim().max(128),
  writeMode: Joi.string().valid(...WRITE_MODES),
  batchSize: Joi.number().integer().min(1).max(100000),
  incrementalColumn: Joi.string().trim().max(128).allow('', null),
  fieldMappings: Joi.array().items(fieldMapping),
  enabled: Joi.boolean(),
  remark: Joi.string().trim().max(255).allow('', null),
  // 调度相关字段（docs/API.md 1.2，对标 FineDataLink）：Mock 阶段仅存储回显，不触发真实调度
  scheduleCron: Joi.string().trim().max(64).allow(null),
  retryCount: Joi.number().integer().min(0).max(10),
  retryIntervalSec: Joi.number().integer().min(0).max(86400),
  // 契约扩展字段（mock 演示用，非必填）：引擎推进进度所需
  totalRows: Joi.number().integer().min(0),
  failureRate: Joi.number().min(0).max(1),
};

const listTasks = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      syncMode: Joi.string().valid(...SYNC_MODES),
      lastStatus: Joi.string().valid(...LAST_STATUSES),
      enabled: Joi.boolean(),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getTask = {
  params: Joi.object().keys({ id }),
};

const createTask = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      syncMode: baseKeys.syncMode.required(),
      sourceId: baseKeys.sourceId.required(),
      sourceTable: baseKeys.sourceTable.required(),
      targetId: baseKeys.targetId.required(),
      targetTable: baseKeys.targetTable.required(),
      incrementalColumn: baseKeys.incrementalColumn.when('syncMode', {
        is: 'incremental',
        then: Joi.string().trim().min(1).max(128).required(),
      }),
    })
    .required(),
};

const updateTask = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      ...baseKeys,
      incrementalColumn: baseKeys.incrementalColumn.when('syncMode', {
        is: 'incremental',
        then: Joi.string().trim().min(1).max(128).required(),
      }),
    })
    .min(1),
};

const deleteTask = {
  params: Joi.object().keys({ id }),
};

/** start / stop 只需要 id；stop 可选携带 instanceId 做幂等校验 */
const startTask = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      failureRate: Joi.number().min(0).max(1),
      totalRows: Joi.number().integer().min(0),
    })
    .unknown(true),
};

const stopTask = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ instanceId: Joi.string().trim().max(64) })
    .unknown(true),
};

const getTaskProgress = {
  params: Joi.object().keys({ id }),
};

const getTaskInstances = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      status: Joi.string().valid('running', 'success', 'failed', 'stopped'),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

module.exports = {
  TRANSFORM_TYPES,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  startTask,
  stopTask,
  getTaskProgress,
  getTaskInstances,
};
