const Joi = require('joi');

/** 数据模型校验（契约 1.12） */

const { LAYERS, ROLES, AGGS } = require('../services/metricmodel.service');

const id = Joi.string().trim().max(64).required();

const columnName = Joi.string()
  .trim()
  .pattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .required();

const column = Joi.object().keys({
  columnName,
  bizName: Joi.string().trim().max(128).allow('', null),
  dataType: Joi.string().trim().max(32).required(),
  role: Joi.string()
    .valid(...ROLES)
    .required(),
  aggDefault: Joi.string().valid('', ...AGGS),
  isKey: Joi.boolean(),
  unit: Joi.string().trim().max(16).allow('', null),
  remark: Joi.string().trim().max(512).allow('', null),
});

const listModels = {
  query: Joi.object()
    .keys({
      domainId: Joi.string().trim().max(64),
      layer: Joi.string().valid(...LAYERS),
      datasourceId: Joi.string().trim().max(64),
      status: Joi.string().valid('online', 'offline'),
      keyword: Joi.string().trim().max(64).allow(''),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getModel = { params: Joi.object().keys({ id }) };

const createModel = {
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(1).max(128).required(),
      datasourceId: Joi.string().trim().max(64).required(),
      domainId: Joi.string().trim().max(64).required(),
      layer: Joi.string()
        .valid(...LAYERS)
        .required(),
      tableName: Joi.string()
        .trim()
        .pattern(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/)
        .required(),
      createType: Joi.string().valid('reference', 'ddl'),
      columns: Joi.array().items(column).max(500),
      timeColumn: Joi.string().trim().max(64).allow(''),
      status: Joi.string().valid('online', 'offline'),
      remark: Joi.string().trim().max(512).allow('', null),
    })
    .required(),
};

const updateModel = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      name: Joi.string().trim().min(1).max(128),
      layer: Joi.string().valid(...LAYERS),
      tableName: Joi.string()
        .trim()
        .pattern(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/),
      timeColumn: Joi.string().trim().max(64).allow(''),
      status: Joi.string().valid('online', 'offline'),
      remark: Joi.string().trim().max(512).allow('', null),
      columns: Joi.array().items(column).max(500),
    })
    .min(1),
};

const replaceColumns = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ columns: Joi.array().items(column).max(500).required() })
    .required(),
};

const deleteModel = { params: Joi.object().keys({ id }) };

const previewDdl = {
  body: Joi.object()
    .keys({
      domainId: Joi.string().trim().max(64).required(),
      layer: Joi.string()
        .valid(...LAYERS)
        .required(),
      name: Joi.string().trim().max(64),
      tableName: Joi.string()
        .trim()
        .pattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      columns: Joi.array().items(column).min(1).max(500).required(),
    })
    .required()
    .oxor('name', 'tableName')
    .messages({ 'object.oxor': 'name 与 tableName 二选一（都不传按 name=表名主体自动生成）' }),
};

module.exports = { listModels, getModel, createModel, updateModel, replaceColumns, deleteModel, previewDdl };
