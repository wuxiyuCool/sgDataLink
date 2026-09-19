const Joi = require('joi');

/**
 * 任务运行实例校验（docs/API.md 第 1.3 节）。
 */

const INSTANCE_STATUSES = ['running', 'success', 'failed', 'stopped'];
/** 契约 1.6 的实例触发方式 */
const TRIGGERS = ['manual', 'cron', 'retry'];
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'];

const id = Joi.string().trim().max(64).required();

const listInstances = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      taskId: Joi.string().trim().max(64),
      /** 数据管道实例按 pipelineId 过滤（pipe- 前缀） */
      pipelineId: Joi.string().trim().max(64),
      status: Joi.string().valid(...INSTANCE_STATUSES),
      trigger: Joi.string().valid(...TRIGGERS),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getInstance = {
  params: Joi.object().keys({ id }),
};

const getInstanceLogs = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(128).allow(''),
      level: Joi.string().valid(...LOG_LEVELS),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getInstanceOffsets = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

module.exports = {
  listInstances,
  getInstance,
  getInstanceLogs,
  getInstanceOffsets,
};
