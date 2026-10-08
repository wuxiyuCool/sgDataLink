const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { metricDomainService } = require('../services');

/**
 * 指标域 HTTP 层（docs/API.md 1.12）。
 */

const listDomains = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'sort']);
  ok(res, { items: await metricDomainService.listDomains(filter) });
});

const getTree = catchAsync(async (req, res) => {
  ok(res, await metricDomainService.getTree());
});

const createDomain = catchAsync(async (req, res) => {
  const result = await metricDomainService.createDomain(req.body, req.user && req.user.username);
  ok(res, result, { message: '创建成功' });
});

const updateDomain = catchAsync(async (req, res) => {
  const result = await metricDomainService.updateDomain(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteDomain = catchAsync(async (req, res) => {
  ok(res, await metricDomainService.deleteDomain(req.params.id), { message: '删除成功' });
});

module.exports = { listDomains, getTree, createDomain, updateDomain, deleteDomain };
