const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { accountService } = require('../services');
const pick = require('../utils/pick');

/**
 * 用户管理（docs/API.md 1.11）：整条路由在路由层要求 JWT + admin（auth('manageUsers')），
 * 这里只处理业务；越权自保护（不能删/禁自己、最后一个 admin）在 account.service 兜底。
 */
const getUsers = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'role', 'status']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await accountService.listUsers({ ...filter, ...options });
  pageResult(res, { ...result, items: (result.items || []).map(accountService.toSafeUser) });
});

const createUser = catchAsync(async (req, res) => {
  ok(res, await accountService.createUser(req.body), { message: '创建成功' });
});

const updateUser = catchAsync(async (req, res) => {
  ok(res, await accountService.updateUser(req.params.id, req.body, req.user), { message: '更新成功' });
});

const deleteUser = catchAsync(async (req, res) => {
  await accountService.deleteUser(req.params.id, req.user);
  ok(res, true, { message: '删除成功' });
});

const resetPassword = catchAsync(async (req, res) => {
  ok(res, await accountService.resetPassword(req.params.id, req.body), { message: '密码已重置' });
});

module.exports = {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  resetPassword,
};
