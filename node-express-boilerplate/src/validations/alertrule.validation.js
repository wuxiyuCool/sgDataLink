const Joi = require('joi');

/**
 * 告警规则校验（docs/API.md 第 1.10 节）。
 * channels 只校验通道类型（webhook / 收件人地址形态太多，Mock 阶段不锁格式）。
 */

const CHANNELS = ['dingtalk', 'wecom', 'email'];
const CONDITIONS = ['task_failed', 'pipeline_error', 'lag_over_threshold'];
const SCOPES = ['all', 'task', 'dataflow', 'pipeline'];

const id = Joi.string().trim().max(64).required();

const channel = Joi.object().keys({
  type: Joi.string().valid(...CHANNELS).required(),
  webhook: Joi.string().trim().max(512).allow('', null),
  // email 通道用 to，其余用 webhook；两者都留空表示只写记录不投递
  to: Joi.string().trim().max(255).allow('', null),
});

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  scope: Joi.string().valid(...SCOPES),
  conditions: Joi.array().items(Joi.string().valid(...CONDITIONS)).min(1).max(CONDITIONS.length),
  /** lag_over_threshold 的判定阈值（毫秒）；null / <=0 表示该规则不参与延迟告警（前端未勾选该条件时提交 null） */
  thresholdLagMs: Joi.number()
    .integer()
    .min(0)
    .max(86400000)
    .allow(null),
  channels: Joi.array().items(channel).max(20),
  enabled: Joi.boolean(),
  remark: Joi.string().trim().max(255).allow('', null),
};

const listAlertRules = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      scope: Joi.string().valid(...SCOPES),
      enabled: Joi.boolean(),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getAlertRule = {
  params: Joi.object().keys({ id }),
};

const createAlertRule = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      conditions: baseKeys.conditions.required(),
      channels: baseKeys.channels.required(),
    })
    .required(),
};

const updateAlertRule = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const deleteAlertRule = {
  params: Joi.object().keys({ id }),
};

module.exports = {
  CHANNELS,
  CONDITIONS,
  SCOPES,
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
};
