const Joi = require('joi');

/**
 * 告警记录校验（docs/API.md 第 1.10 节）。
 * 记录由触发链路写入，管理端只读 + 标记已读，所以只有 query / params 两类 schema。
 */

const LEVELS = ['INFO', 'WARN', 'ERROR'];
const TARGET_TYPES = ['task', 'dataflow', 'pipeline'];

const id = Joi.string().trim().max(64).required();

const listAlertRecords = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      level: Joi.string().valid(...LEVELS),
      /** read 支持 true / false 查询串（Joi.boolean() 会吞掉 'false' 之外的值） */
      read: Joi.boolean(),
      ruleId: Joi.string().trim().max(64),
      targetType: Joi.string().valid(...TARGET_TYPES),
      targetId: Joi.string().trim().max(64),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getAlertRecord = {
  params: Joi.object().keys({ id }),
};

const markAlertRecordRead = {
  params: Joi.object().keys({ id }),
  body: Joi.object().unknown(true),
};

module.exports = {
  LEVELS,
  TARGET_TYPES,
  listAlertRecords,
  getAlertRecord,
  markAlertRecordRead,
};
