const Joi = require('joi');

/** 指标校验（契约 1.12 §6）：结构性校验在此，语义校验（聚合规则/循环/跨源）在 metric.service */

const id = Joi.string().trim().max(64).required();

const defineParams = Joi.object().unknown(true);

const baseKeys = {
  code: Joi.string().trim().min(3).max(64),
  name: Joi.string().trim().min(1).max(128),
  alias: Joi.array().items(Joi.string().trim().max(128)).max(50),
  defineType: Joi.string().valid('MEASURE', 'FIELD', 'METRIC'),
  defineParams,
  expr: Joi.string().trim().max(4000).allow('', null),
  domainId: Joi.string().trim().max(64).allow(''),
  unit: Joi.string().trim().max(32).allow(''),
  dataFormat: Joi.string().valid('DECIMAL', 'PERCENT', 'THOUSANDTH'),
  caliber: Joi.string().trim().max(4000).allow('', null),
  owner: Joi.string().trim().max(64).allow(''),
  status: Joi.string().valid('draft', 'online', 'offline'),
  remark: Joi.string().trim().max(512).allow('', null),
  changeNote: Joi.string().trim().max(512).allow('', null),
};

const listMetrics = {
  query: Joi.object()
    .keys({
      domainId: Joi.string().trim().max(64),
      modelId: Joi.string().trim().max(64),
      type: Joi.string().valid('ATOMIC', 'DERIVED', 'COMPOSITE'),
      status: Joi.string().valid('draft', 'online', 'offline'),
      keyword: Joi.string().trim().max(64).allow(''),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getMetric = { params: Joi.object().keys({ id }) };

const createMetric = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      code: baseKeys.code.required(),
      name: baseKeys.name.required(),
      defineType: baseKeys.defineType.required(),
    })
    .required(),
};

const updateMetric = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const validateDraft = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      code: baseKeys.code.required(),
      name: baseKeys.name.required(),
      defineType: baseKeys.defineType.required(),
      id: Joi.string().trim().max(64), // 编辑中校验时排除自身
    })
    .required(),
};

const deleteMetric = { params: Joi.object().keys({ id }) };

const getTree = { params: Joi.object().keys({ id }) };
const getLineage = { params: Joi.object().keys({ id }) };

const preview = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      dateRange: Joi.object().keys({
        start: Joi.string()
          .trim()
          .pattern(/^\d{4}-\d{2}-\d{2}$/),
        end: Joi.string()
          .trim()
          .pattern(/^\d{4}-\d{2}-\d{2}$/),
      }),
      dimensions: Joi.array().items(Joi.string().trim().max(64)).max(20),
      limit: Joi.number().integer().min(1).max(100000),
    })
    .unknown(true),
};

const listVersions = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
    })
    .unknown(true),
};

const rollback = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ version: Joi.number().integer().min(1).required() })
    .required(),
};

module.exports = {
  listMetrics,
  getMetric,
  createMetric,
  updateMetric,
  validateDraft,
  deleteMetric,
  getTree,
  getLineage,
  preview,
  listVersions,
  rollback,
};
