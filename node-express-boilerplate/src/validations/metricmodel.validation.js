const Joi = require('joi');

/** 数据模型校验（契约 1.12） */

const { LAYERS, ROLES, AGGS, STATUSES } = require('../services/metricmodel.service');

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
      status: Joi.string().valid(...STATUSES),
      /** 契约 1.16：按分类精确筛；字面量 none＝该范围内未分类（服务端翻成空值谓词，不是 id） */
      categoryId: Joi.string().trim().max(64).allow(''),
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
        .pattern(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/),
      createType: Joi.string().valid('reference', 'ddl'),
      columns: Joi.array().items(column).max(500),
      timeColumn: Joi.string().trim().max(64).allow(''),
      status: Joi.string().valid(...STATUSES),
      /** 契约 1.16：归属的分类（mcat-），空串/null＝该层未分类；同层校验在 service（跨层 40001） */
      categoryId: Joi.string().trim().max(64).allow('', null),
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
      status: Joi.string().valid(...STATUSES),
      /** 契约 1.16：可改列；空串＝移出回未分类，跨层由 service 40001 */
      categoryId: Joi.string().trim().max(64).allow('', null),
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

const deleteModel = {
  params: Joi.object().keys({ id }),
  /** dropTable=true 连带删除物理表（仅平台建的表，服务端另有硬闸门） */
  query: Joi.object().keys({ dropTable: Joi.boolean() }),
};

const createTable = { params: Joi.object().keys({ id }) };

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
      /** 目标数据源：决定 DDL 用哪家方言（不传按 mysql） */
      datasourceId: Joi.string().trim().max(64),
    })
    .required()
    .or('name', 'tableName')
    .messages({ 'object.or': 'name 与 tableName 至少给一个（给了 tableName 以它为准，否则按 name 自动拼表名）' }),
};

/** 维度取值探查（契约 1.14）：只允许探查该模型的维度列，条数与基数阈值有上限（防大表 GROUP BY 压库） */
const profileDimensions = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      columns: Joi.array().items(Joi.string().trim().max(64)).max(50),
      topN: Joi.number().integer().min(1).max(200),
      distinctGuard: Joi.number().integer().min(1).max(5000),
    })
    .unknown(true),
};

const getDimensionValues = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({
      columnName: Joi.string().trim().max(64),
      keyword: Joi.string().trim().max(64).allow(''),
    })
    .unknown(true),
};

const saveDimensionValues = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      columnName: Joi.string().trim().max(64).required(),
      values: Joi.array()
        .items(
          Joi.object()
            .keys({
              value: Joi.string().trim().min(1).max(191).required(),
              label: Joi.string().trim().max(191).allow('', null),
            })
            .required()
        )
        .min(1)
        .max(200)
        .required(),
    })
    .required(),
};

const clearDimensionValues = {
  params: Joi.object().keys({ id }),
  query: Joi.object()
    .keys({ columnName: Joi.string().trim().max(64).required() })
    .unknown(true),
};

module.exports = {
  listModels,
  getModel,
  createModel,
  updateModel,
  replaceColumns,
  deleteModel,
  createTable,
  previewDdl,
  profileDimensions,
  getDimensionValues,
  saveDimensionValues,
  clearDimensionValues,
};
