const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const mysql = require('./db/mysql');
const { initMysql } = require('./db/init');
const { seed } = require('./repositories');
const datasourceRepository = require('./repositories/datasource.repository');
// 先加载 services 聚合入口：它会把 task / dataflow 两种「可运行体」注册进 run.service，
// 调度器与失败重试都靠这份 registry 找到该调谁的 start()。
const { schedulerService } = require('./services');

let server;

/** 监听 + 启动调度器（三种启动方式共用的收尾） */
const listen = (message) => {
  server = app.listen(config.port, () => {
    logger.info(`Listening to port ${config.port}`);
  });
  // 契约 1.6：真实的定时调度器（每秒扫一遍带 scheduleCron 的任务 / 数据开发）
  schedulerService.startScheduler();
  if (message) logger.info(message);
};

/**
 * 启动方式三选一（src/index.js 的装配点，对应 docs/API.md 第 4 节）：
 * - DB_DRIVER=mysql：建池 -> 逐表 CREATE TABLE IF NOT EXISTS -> 调度 -> listen，
 *   **默认不注入演示种子**（契约 4.1「空库起步」），只有 SEED_DEMO=true 才 seed()；
 * - DB_DRIVER=memory 且 MEM_MOCK=true（默认）：不连任何数据库，内存仓储 + 种子数据；
 * - MEM_MOCK=false 且 DB_DRIVER=memory：走脚手架原逻辑，先连 MongoDB 再 listen。
 */
const startWithMysql = async () => {
  await initMysql();
  logger.info('running with mysql repositories (driver=mysql)');
  if (config.seedDemo) {
    await seed();
  } else {
    // 只在 databridge_datasource 仍是空表时提示「生产测试模式」，有真实配置就安静启动
    const datasourceTotal = await datasourceRepository.count();
    if (!datasourceTotal) {
      logger.info('空库启动（生产测试模式），如需演示数据设 SEED_DEMO=true');
    } else {
      logger.info('空库起步已生效（不注入演示种子），当前数据源 %d 条', datasourceTotal);
    }
  }
  listen('mysql driver ready');
};

const startInMemoryMockMode = async () => {
  logger.info('running in memory-mock mode');
  await seed();
  listen();
};

const startWithMongo = () => {
  mongoose.connect(config.mongoose.url, config.mongoose.options).then(() => {
    logger.info('Connected to MongoDB');
    listen();
  });
};

const bootstrap = async () => {
  try {
    if (config.db.driver === 'mysql') {
      await startWithMysql();
    } else if (config.memMock) {
      await startInMemoryMockMode();
    } else {
      startWithMongo();
    }
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

bootstrap();

/** mysql 驱动下把连接池关掉再退出，避免半关的连接让远端留一堆 sleep 会话 */
const closeMysqlPool = async () => {
  if (config.db.driver !== 'mysql') return false;
  try {
    await mysql.closeMysqlPool();
    logger.info('MySQL pool closed');
    return true;
  } catch (err) {
    logger.warn('MySQL pool close failed: %s', err.message);
    return false;
  }
};

const exitHandler = () => {
  // 先停掉 cron 扫描与排程中的重试，否则定时器会让进程迟迟不退
  schedulerService.shutdownScheduling();
  closeMysqlPool().then(() => {
    if (server) {
      server.close(() => {
        logger.info('Server closed');
        process.exit(1);
      });
    } else {
      process.exit(1);
    }
  });
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
  closeMysqlPool().then(() => {
    if (server) {
      server.close();
    }
  });
});
