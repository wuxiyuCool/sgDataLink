const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const { seed } = require('./repositories');
// 先加载 services 聚合入口：它会把 task / dataflow 两种「可运行体」注册进 run.service，
// 调度器与失败重试都靠这份 registry 找到该调谁的 start()。
const { schedulerService } = require('./services');

let server;

/**
 * 启动方式二选一（保持原有 DB 路径不变）：
 * - MEM_MOCK=true（默认）：不连任何数据库，全部走 src/repositories 内存仓储 + 种子数据；
 * - MEM_MOCK=false：走脚手架原逻辑，先连 MongoDB 再 listen。
 */
const startInMemoryMockMode = () => {
  logger.info('running in memory-mock mode');
  seed();
  server = app.listen(config.port, () => {
    logger.info(`Listening to port ${config.port}`);
  });
  // 契约 1.6：Mock 阶段就启动真实的定时调度器（每秒扫一遍带 scheduleCron 的任务 / 数据开发）
  schedulerService.startScheduler();
};

const startWithMongo = () => {
  mongoose.connect(config.mongoose.url, config.mongoose.options).then(() => {
    logger.info('Connected to MongoDB');
    server = app.listen(config.port, () => {
      logger.info(`Listening to port ${config.port}`);
    });
  });
};

if (config.memMock) {
  startInMemoryMockMode();
} else {
  startWithMongo();
}

const exitHandler = () => {
  // 先停掉 cron 扫描与排程中的重试，否则定时器会让进程迟迟不退
  schedulerService.shutdownScheduling();
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  logger.error(error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  schedulerService.shutdownScheduling();
  if (server) {
    server.close();
  }
});
