const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { taskInstanceService } = require('../services');

/**
 * 运维统计 HTTP 层（docs/API.md 第 1.5 节，对标 FineDataLink 运维监控大盘）。
 */

/** GET /statistics/overview —— 总量 + 今日实例聚合 + 最近 7 天趋势 */
const getOverview = catchAsync(async (req, res) => {
  const result = await taskInstanceService.getStatisticsOverview();
  ok(res, result);
});

module.exports = {
  getOverview,
};
