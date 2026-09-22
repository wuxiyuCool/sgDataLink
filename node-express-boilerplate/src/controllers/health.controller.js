const catchAsync = require('../utils/catchAsync');
const config = require('../config/config');
const { ok } = require('../utils/apiResponse');

/**
 * 健康检查（docs/API.md 第 1.5 节）。
 * GET /api/v1/health → { code: 0, result: { status: 'ok', service: 'databridge-admin', mock: true } }
 */
const getHealth = catchAsync(async (req, res) => {
  const storage = config.db.isMysql() ? 'mysql' : 'memory';
  ok(res, {
    status: 'ok',
    service: 'databridge-admin',
    // mock = 存储层是否内存模拟（DB_DRIVER=memory）；引擎侧始终是模拟器，不受此开关影响
    mock: storage === 'memory',
    storage,
    engineBaseUrl: config.engine.baseUrl,
    reportUrl: config.engine.reportUrl,
    uptimeSec: Math.floor(process.uptime()),
    memoryMode: storage === 'mysql' ? `mysql://${config.db.mysql.host}:${config.db.mysql.port}/${config.db.mysql.database}` : 'in-memory',
  });
});

module.exports = {
  getHealth,
};
