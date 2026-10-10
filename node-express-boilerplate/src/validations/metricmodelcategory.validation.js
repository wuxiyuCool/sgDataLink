const Joi = require('joi');

/**
 * 建模分层树「分类」校验（契约 1.16 / V11 四期）。
 * layer 只在创建时收（PUT 里带上它由 service 明确拒绝，给出「新建分类再批量归类」的可执行提示）。
 */

const { LAYERS } = require('../services/metricmodel.service');

const id = Joi.string().trim().max(64).required();

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  layer: Joi.string().valid(...LAYERS),
  description: Joi.string().trim().max(512).allow('', null),
  sort: Joi.number().integer().min(0).max(9999),
};

const getTree = { query: Joi.object().unknown(true) };

const createCategory = {
  body: Joi.object()
    .keys({ ...baseKeys, name: baseKeys.name.required(), layer: baseKeys.layer.required() })
    .required(),
};

const updateCategory = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const deleteCategory = { params: Joi.object().keys({ id }) };

/** POST /metric-model-categories/assign：categoryId 空串＝移出回未分类；跨层逐条点名不整批失败 */
const assignCategories = {
  body: Joi.object()
    .keys({
      categoryId: Joi.string().trim().max(64).allow('', null),
      modelIds: Joi.array().items(Joi.string().trim().max(64).required()).max(500).default([]),
    })
    .required(),
};

module.exports = { getTree, createCategory, updateCategory, deleteCategory, assignCategories };
