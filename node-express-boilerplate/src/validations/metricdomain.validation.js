const Joi = require('joi');

/** 指标域校验（契约 1.12）：code 终身制（创建后不可改，service 兜底） */

const id = Joi.string().trim().max(64).required();

const code = Joi.string()
  .trim()
  .pattern(/^[a-z][a-z0-9_]{1,30}$/)
  .message('code 需为小写字母开头、仅含小写字母数字下划线、长度 2~31');

const baseKeys = {
  name: Joi.string().trim().min(1).max(128),
  code,
  parentId: Joi.string().trim().max(64),
  tablePrefix: Joi.string()
    .trim()
    .pattern(/^[a-z][a-z0-9_]{0,30}$/)
    .allow(''),
  owner: Joi.string().trim().max(64).allow(''),
  sort: Joi.number().integer().min(0).max(9999),
  remark: Joi.string().trim().max(512).allow('', null),
};

const listDomains = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      sort: Joi.string()
        .trim()
        .pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
    })
    .unknown(true),
};

const getDomain = { params: Joi.object().keys({ id }) };
const getTree = { query: Joi.object().unknown(true) };

const createDomain = {
  body: Joi.object()
    .keys({ ...baseKeys, name: baseKeys.name.required(), code: code.required() })
    .required(),
};

const updateDomain = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const deleteDomain = { params: Joi.object().keys({ id }) };

module.exports = { listDomains, getTree, getDomain, createDomain, updateDomain, deleteDomain };
