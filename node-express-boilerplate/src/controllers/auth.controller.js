const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { accountService } = require('../services');

/**
 * 鉴权端点（docs/API.md 1.11）。登录挂 authLimiter（路由文件里），
 * 失败信封由全局 errorHandler 渲染（40103/40104）。
 */
const login = catchAsync(async (req, res) => {
  const result = await accountService.login(req.body);
  ok(res, result);
});

const me = catchAsync(async (req, res) => {
  ok(res, accountService.toSafeUser(req.user));
});

const changePassword = catchAsync(async (req, res) => {
  await accountService.changeOwnPassword(req.user, req.body);
  ok(res, true);
});

module.exports = {
  login,
  me,
  changePassword,
};
