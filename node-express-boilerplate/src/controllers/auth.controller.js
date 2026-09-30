const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { accountService } = require('../services');

/** 客户端 IP：反向代理（nginx）后优先 X-Forwarded-For 首段，与 dataApi 运行时同口径 */
const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim();
  return first || req.headers['x-real-ip'] || req.ip || '';
};

/**
 * 鉴权端点（docs/API.md 1.11）。登录挂 authLimiter（路由文件里），
 * 失败信封由全局 errorHandler 渲染（40103/40104）。
 * 成败都会落一条登录日志（含 IP），login-logs 查询仅 admin 可达。
 */
const login = catchAsync(async (req, res) => {
  const result = await accountService.login({ ...req.body, ip: clientIp(req) });
  ok(res, result);
});

const me = catchAsync(async (req, res) => {
  ok(res, accountService.toSafeUser(req.user));
});

const changePassword = catchAsync(async (req, res) => {
  await accountService.changeOwnPassword(req.user, req.body);
  ok(res, true);
});

const loginLogs = catchAsync(async (req, res) => {
  pageResult(res, await accountService.pageLoginLogs(req.query));
});

module.exports = {
  login,
  me,
  changePassword,
  loginLogs,
};
