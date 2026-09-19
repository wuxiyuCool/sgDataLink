const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { engineReportService } = require('../services');

/**
 * Go 引擎回调 HTTP 层（docs/API.md 第 1.4 节）。
 * Mock 阶段不鉴权，仅接受引擎内网上报。
 */

/** POST /engine/report —— 上报状态 / 进度，result: { accepted: true } */
const report = catchAsync(async (req, res) => {
  const result = await engineReportService.reportProgress(req.body);
  ok(res, result);
});

/** POST /engine/logs —— 批量上报日志，result: { accepted: <n> } */
const logs = catchAsync(async (req, res) => {
  const result = await engineReportService.ingestLogs(req.body);
  ok(res, result);
});

module.exports = {
  report,
  logs,
};
