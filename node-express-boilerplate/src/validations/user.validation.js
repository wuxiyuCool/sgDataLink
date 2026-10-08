const Joi = require('joi');

/**
 * 用户管理校验（docs/API.md 1.11）。
 * 密码强度规则（8~64 位、字母+数字）在这里做格式粗检，account.service 再权威校验并哈希。
 * username 的字符集校验放 service（要小写归一后判断），这里只限长度假隔注入面。
 */
const id = Joi.string().trim().max(64).required();

const listUsers = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      role: Joi.string().valid('admin', 'user'),
      status: Joi.string().valid('active', 'disabled'),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(200),
    })
    .unknown(true),
};

const createUser = {
  body: Joi.object().keys({
    username: Joi.string().trim().min(3).max(32).required(),
    nickname: Joi.string().trim().max(128).allow('', null),
    password: Joi.string().min(8).max(64).required(),
    role: Joi.string().valid('admin', 'user'),
  }),
};

const updateUser = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      nickname: Joi.string().trim().max(128).allow(''),
      role: Joi.string().valid('admin', 'user'),
      status: Joi.string().valid('active', 'disabled'),
      // 1.9.5 文档中心免登录访问权限（开通自动发 key，关闭清空）
      docAccess: Joi.boolean(),
      // 契约 1.12 问数对外服务权限（与 docAccess 同构）
      chatAccess: Joi.boolean(),
    })
    .min(1),
};

const deleteUser = {
  params: Joi.object().keys({ id }),
};

const resetPassword = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys({
    password: Joi.string().min(8).max(64).required(),
  }),
};

module.exports = {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  resetPassword,
};
