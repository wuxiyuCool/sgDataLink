const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { metricDashboardService } = require('../services');

/**
 * 指标中心首页概览 HTTP 层（docs/API.md 1.12）。
 */

const getDashboard = catchAsync(async (req, res) => {
  ok(res, await metricDashboardService.getDashboard());
});

module.exports = { getDashboard };
