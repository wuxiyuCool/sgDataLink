const Joi = require('joi');

/**
 * 智能问数相关校验（docs/API.md 1.12 §7.4）：/metric-chat/ask、/metric-terms、
 * /metric-examples、/metric-logs。
 */

const id = Joi.string().trim().max(64).required();

const dateOnly = Joi.string()
  .trim()
  .pattern(/^\d{4}-\d{2}-\d{2}$/);

const listQuery = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(128).allow(''),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
    })
    .unknown(true),
};

const ask = {
  body: Joi.object()
    .keys({
      question: Joi.string().trim().min(1).max(1000).required(),
      sessionId: Joi.string().trim().max(64).allow('', null),
      dateRange: Joi.object()
        .keys({
          start: dateOnly.required(),
          end: dateOnly.required(),
        })
        .allow(null),
    })
    .required(),
};

const termBody = {
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(1).max(128),
      alias: Joi.array().items(Joi.string().trim().max(128)).max(50),
      description: Joi.string().trim().max(2000).allow('', null),
      relatedMetricIds: Joi.array().items(Joi.string().trim().max(64)).max(50),
      relatedModelIds: Joi.array().items(Joi.string().trim().max(64)).max(50),
    })
    .unknown(true),
};

const exampleBody = {
  body: Joi.object()
    .keys({
      question: Joi.string().trim().min(1).max(512),
      m2sql: Joi.string().trim().min(1).max(4000),
      enabled: Joi.boolean(),
      note: Joi.string().trim().max(512).allow('', null),
    })
    .unknown(true),
};

const idParam = { params: Joi.object().keys({ id }) };

const sessionParam = { params: Joi.object().keys({ id: Joi.string().trim().min(1).max(64).required() }) };

const listLogs = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(128).allow(''),
      status: Joi.string().valid('success', 'corrected', 'clarify', 'failed'),
      result: Joi.string().valid('success', 'corrected', 'clarify', 'failed'),
      userName: Joi.string().trim().max(64).allow(''),
      startTime: Joi.string().trim().isoDate(),
      endTime: Joi.string().trim().isoDate(),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

module.exports = {
  ask,
  listTerms: listQuery,
  termBody,
  termParam: { params: Joi.object().keys({ id }) },
  termUpdate: {
    params: Joi.object().keys({ id }),
    body: termBody.body,
  },
  listExamples: listQuery,
  exampleBody,
  exampleUpdate: {
    params: Joi.object().keys({ id }),
    body: exampleBody.body,
  },
  exampleParam: idParam,
  listLogs,
  logToExample: idParam,
  sessionParam,
};
