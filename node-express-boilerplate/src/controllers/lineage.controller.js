const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { lineageService } = require('../services');

/**
 * 数据血缘 HTTP 层（docs/API.md 第 1.10 节 GET /lineage/graph）。
 * 图由 services/lineage.service.js 从内存定义实时聚合，无独立存储。
 */
const getGraph = catchAsync(async (req, res) => {
  const result = await lineageService.buildLineageGraph();
  ok(res, result);
});

module.exports = {
  getGraph,
};
