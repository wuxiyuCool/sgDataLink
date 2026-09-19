const Joi = require('joi');

/**
 * 数据管道（CDC）校验（docs/API.md 第 1.7 节）。
 * 结构校验在这里，「数据源是否存在 / syncObjects 是否为空 / running 禁止改删」
 * 由 services/pipeline.service.js 兜底，统一返回 40001 / 40003。
 */

const PIPELINE_STATUSES = ['running', 'stopped'];
/** DDL 变更策略占位枚举（Mock 阶段只存储回显） */
const DDL_POLICIES = ['ignore', 'report'];

const id = Joi.string().trim().max(64).required();

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  sourceId: Joi.string().trim().max(64),
  targetId: Joi.string().trim().max(64),
  // 同步对象：形如 APP_USER.T_ORDER 的表清单（整库/多表实时镜像）
  syncObjects: Joi.array().items(Joi.string().trim().min(1).max(256)).min(1).max(500),
  ddlPolicy: Joi.string().valid(...DDL_POLICIES),
  // 下面两项不进契约的管道对象示例，但引擎 cdc 快照需要，允许配置用于演示失败态
  batchSize: Joi.number().integer().min(1).max(100000),
  failureRate: Joi.number().min(0).max(1),
  remark: Joi.string().trim().max(255).allow('', null),
};

const listPipelines = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      status: Joi.string().valid(...PIPELINE_STATUSES),
      sourceId: Joi.string().trim().max(64),
      targetId: Joi.string().trim().max(64),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getPipeline = {
  params: Joi.object().keys({ id }),
};

const createPipeline = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      sourceId: baseKeys.sourceId.required(),
      targetId: baseKeys.targetId.required(),
      syncObjects: baseKeys.syncObjects.required(),
    })
    .required(),
};

const updatePipeline = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const deletePipeline = {
  params: Joi.object().keys({ id }),
};

/** start / stop 只带 id；trigger 供脚本调试（manual|cron|retry），缺省 manual */
const startPipeline = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      trigger: Joi.string().valid('manual', 'cron', 'retry'),
    })
    .unknown(true),
};

const stopPipeline = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ instanceId: Joi.string().trim().max(64) })
    .unknown(true),
};

const getPipelineStatus = {
  params: Joi.object().keys({ id }),
};

module.exports = {
  DDL_POLICIES,
  PIPELINE_STATUSES,
  listPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
  startPipeline,
  stopPipeline,
  getPipelineStatus,
};
