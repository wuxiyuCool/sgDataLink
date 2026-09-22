/**
 * Node 内置定时调度器（docs/API.md 第 1.6 节）。
 *
 * 在 memory 与 mysql 两种驱动下都会启动（src/index.js 调 startScheduler），
 * 每秒扫一遍所有「enabled 且配了 scheduleCron」的同步任务与数据开发流程
 * （两者的调度字段同构，可调度清单来自 services/run.service.js 的 registry），
 * 命中 cron 且同一条记录距上次触发超过 60s、当前没有 running 实例时，
 * 就以 trigger=cron 调 start 重新下发引擎。
 *
 * running 中跳过会记 WARN（契约 1.6 明确要求）；表达式不属于支持的 6 位 Quartz 子集时
 * 只 WARN 一次，避免每秒刷屏。进程退出时 stopScheduler 清掉 interval，配合
 * run.service.cancelPendingRetries 一起保证不会把 Node 挂住。
 *
 * 仓储双驱动后扫描是异步的：用 scanning 标记做「同一时刻只有一轮在扫」，
 * 上一轮没扫完（DB 抖动 / 引擎慢）就跳过这一轮，避免把引擎刷爆。
 * lastTriggerAt（cron 最小间隔）与 warnedCrons 保持内存态，不落库。
 */
const logger = require('../config/logger');
const config = require('../config/config');
const cronMatcher = require('../utils/cronMatcher');
const instanceRepository = require('../repositories/instance.repository');
const runService = require('./run.service');

/** 扫描周期：cron 有「秒」位，所以按秒对齐（Date 的 UTC 秒变化即命中判定变化） */
const TICK_MS = 1000;

/** 同一条记录两次 cron 触发的最小间隔（防止 `* * * * * *` 这类表达式把引擎刷爆） */
const MIN_TRIGGER_GAP_MS = 60 * 1000;

let timer = null;

/** 上一轮扫描是否还没结束（异步扫描的重入保护） */
let scanning = false;

/** `${kind}:${id}` -> 最近一次 cron 触发时间戳 */
const lastTriggerAt = new Map();

/** 已经 WARN 过的非法/不支持 cron，避免重复刷屏 */
const warnedCrons = new Set();

/**
 * 扫描一次（导出纯函数式入口，便于单测直接传 now）。
 * @param {Date} [now] 判定时刻
 * @returns {Promise<Array>} 本轮已下发的启动 Promise
 */
const scanOnce = async (now = new Date()) => {
  const pending = [];
  const records = await runService.listSchedulableRecords();
  // eslint-disable-next-line no-restricted-syntax
  for (const { kind, label, record } of records) {
    if (record.enabled === false || !record.scheduleCron) continue;
    const key = `${kind}:${record.id}`;

    if (!cronMatcher.isSupportedCron(record.scheduleCron)) {
      if (!warnedCrons.has(key)) {
        warnedCrons.add(key);
        logger.warn(
          'schedule skipped: %s %s 的 scheduleCron「%s」不在支持的 6 位 Quartz 子集（秒 分 时 日 月 周，字段仅支持 * / ? / 数字）内',
          label,
          record.id,
          record.scheduleCron
        );
      }
      continue;
    }
    if (!cronMatcher.matchesCron(record.scheduleCron, now)) continue;

    const previous = lastTriggerAt.get(key) || 0;
    if (now.getTime() - previous < MIN_TRIGGER_GAP_MS) continue;

    // eslint-disable-next-line no-await-in-loop
    const running = await instanceRepository.findRunningByTask(record.id);
    if (record.lastStatus === 'running' || running) {
      logger.warn('%s %s 正在运行中，本次定时触发跳过', label, record.id);
      continue;
    }

    lastTriggerAt.set(key, now.getTime());
    const runner = runService.getRunner(kind);
    if (!runner || !runner.api) {
      logger.warn('schedule skipped: 未注册的运行体 %s', kind);
      continue;
    }
    logger.info('cron trigger: %s %s (cron=%s)', label, record.id, record.scheduleCron);
    // eslint-disable-next-line no-await-in-loop
    pending.push(
      runner.api.start(record.id, { trigger: 'cron' }).catch((err) => {
        // 引擎不可达 / 并发启动等情况不影响调度器存活，只记日志
        logger.warn('cron start failed for %s: %s', record.id, err.message);
      })
    );
  }
  return pending;
};

/** 调度器是否应在本进程启用（memory mock 模式与 mysql 驱动模式都要跑调度） */
const schedulingEnabled = () => config.memMock || config.db.driver === 'mysql';

/** 启动调度器（memory / mysql 驱动；重复调用幂等） */
const startScheduler = () => {
  if (!schedulingEnabled()) {
    logger.info('scheduler not started: neither memory-mock nor mysql driver is enabled');
    return false;
  }
  if (timer) return true;
  timer = setInterval(() => {
    if (scanning) return;
    scanning = true;
    scanOnce(new Date())
      .catch((err) => logger.error('scheduler tick error: %s', err.message))
      .then(() => {
        scanning = false;
      });
  }, TICK_MS);
  // 调度器不应该阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('scheduler started: tick=%dms, minGap=%dms', TICK_MS, MIN_TRIGGER_GAP_MS);
  return true;
};

/** 停止调度器并清理触发记录（进程退出时调用） */
const stopScheduler = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('scheduler stopped');
  }
  lastTriggerAt.clear();
  warnedCrons.clear();
};

/**
 * 彻底收尾：停 cron 扫描 + 取消所有排程中的失败重试。
 * 由 src/index.js 的 exitHandler / SIGTERM 调用，保证进程能真正退出。
 */
const shutdownScheduling = () => {
  stopScheduler();
  runService.cancelPendingRetries();
};

const isRunning = () => Boolean(timer);

module.exports = {
  TICK_MS,
  MIN_TRIGGER_GAP_MS,
  scanOnce,
  startScheduler,
  stopScheduler,
  shutdownScheduling,
  isRunning,
};
