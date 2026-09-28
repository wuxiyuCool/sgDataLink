const Joi = require('joi');

/**
 * 鉴权路由校验（docs/API.md 1.11）：用户名 + 密码登录，无注册/邮箱验证概念，
 * 账号生命周期由 /users 管理接口控制。
 */
const login = {
  body: Joi.object().keys({
    username: Joi.string().trim().max(64).required(),
    password: Joi.string().max(128).required(),
  }),
};

const changePassword = {
  body: Joi.object().keys({
    oldPassword: Joi.string().max(128).required(),
    newPassword: Joi.string().min(8).max(64).required(),
  }),
};

module.exports = {
  login,
  changePassword,
};
