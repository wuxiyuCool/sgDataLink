const catchAsync = require('../utils/catchAsync');
const config = require('../config/config');
const { ok } = require('../utils/apiResponse');

/**
 * 健康检查（docs/API.md 第 1.5 节）。
 * GET /api/v1/health → { code: 0, result: { status: 'ok', service: 'databridge-admin', mock: true } }
 */
const getHealth = catchAsync(async (req, res) => {
  ok(res, {
    status: 'ok',
    service: 'databridge-admin',
    mock: config.memMock,
    engineBaseUrl: config.engine.baseUrl,
    reportUrl: config.engine.reportUrl,
    uptimeSec: Math.floor(process.uptime()),
    memoryMode: config.memMock ? 'in-memory' : 'mongodb',
  });
});

module.exports = {
  getHealth,
};
