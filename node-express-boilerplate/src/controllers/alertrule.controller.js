const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { alertService } = require('../services');

/**
 * 告警规则 HTTP 层（docs/API.md 第 1.10 节 /alert-rules）。
 * 触发判定与投递记录写入在 services/alert.service.js。
 */

const getAlertRules = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'scope', 'enabled']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await alertService.queryRules(filter, options);
  pageResult(res, result);
});

const getAlertRule = catchAsync(async (req, res) => {
  const result = await alertService.getRuleById(req.params.id);
  ok(res, result);
});

const createAlertRule = catchAsync(async (req, res) => {
  const result = await alertService.createRule(req.body);
  ok(res, result, { message: '创建成功' });
});

const updateAlertRule = catchAsync(async (req, res) => {
  const result = await alertService.updateRuleById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteAlertRule = catchAsync(async (req, res) => {
  const result = await alertService.deleteRuleById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

module.exports = {
  getAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
};
