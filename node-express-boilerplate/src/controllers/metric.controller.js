const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { metricService, metricExecService } = require('../services');

/**
 * 指标管理 HTTP 层（docs/API.md 1.12 §6）。
 */

const getMetrics = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['domainId', 'modelId', 'type', 'status']);
  const options = pick(req.query, ['keyword', 'page', 'size', 'sort']);
  pageResult(res, await metricService.queryMetrics(filter, options));
});

const getMetric = catchAsync(async (req, res) => {
  ok(res, await metricService.getActiveMetric(req.params.id));
});

const createMetric = catchAsync(async (req, res) => {
  const result = await metricService.createMetric(req.body, req.user && req.user.username);
  ok(res, result, { message: '创建成功' });
});

const updateMetric = catchAsync(async (req, res) => {
  const result = await metricService.updateMetric(req.params.id, req.body, req.user && req.user.username);
  ok(res, result, { message: '更新成功' });
});

const validateDraft = catchAsync(async (req, res) => {
  const { errors, warnings } = await metricService.validateMetric(req.body, req.body.id || null);
  ok(res, { valid: errors.length === 0, errors, warnings });
});

const deleteMetric = catchAsync(async (req, res) => {
  ok(res, await metricService.deleteMetric(req.params.id), { message: '删除成功' });
});

const getTree = catchAsync(async (req, res) => {
  ok(res, await metricService.getTree(req.params.id));
});

const getLineage = catchAsync(async (req, res) => {
  ok(res, await metricService.getLineage(req.params.id));
});

/** 试跑：编译 + 经引擎真实执行（memory 驱动只回 SQL，executable=false） */
const preview = catchAsync(async (req, res) => {
  ok(res, await metricExecService.previewMetric(req.params.id, req.body || {}));
});

const listVersions = catchAsync(async (req, res) => {
  ok(res, { items: await metricService.listVersions(req.params.id) });
});

const rollback = catchAsync(async (req, res) => {
  const result = await metricService.rollback(req.params.id, req.body.version, req.user && req.user.username);
  ok(res, result, { message: '已回滚为新草稿' });
});

module.exports = {
  getMetrics,
  getMetric,
  createMetric,
  updateMetric,
  validateDraft,
  deleteMetric,
  getTree,
  getLineage,
  preview,
  listVersions,
  rollback,
};
