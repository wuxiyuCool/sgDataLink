const Joi = require('joi');

/**
 * Go 引擎回调入参校验（docs/API.md 第 1.4 节）。
 * 引擎是本服务内部组件，这里只做形状约束，不做鉴权（Mock 阶段）。
 */

const INSTANCE_STATUSES = ['running', 'success', 'failed', 'stopped'];
const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'];
/** 契约 1.6 的触发方式：实例回报若携带则一并回写 */
const TRIGGERS = ['manual', 'cron', 'retry'];

const report = {
  body: Joi.object()
    .keys({
      instanceId: Joi.string().trim().max(64).required(),
      // cdc 管道回报无任务归属：引擎可能省略、置 null 或空串，一律接受
      taskId: Joi.string().trim().max(64).allow(null, ''),
      /** 仅 cdc 数据管道回报携带（docs/API.md 1.4 / 1.7）：非空即走管道运行态分支 */
      pipelineId: Joi.string().trim().max(64).allow(null, ''),
      status: Joi.string().valid(...INSTANCE_STATUSES),
      progress: Joi.number().min(0).max(100),
      // cdc 回报按契约把 totalRows 置为 null，所以这里 allow(null)
      totalRows: Joi.number().integer().min(0).allow(null),
      readRows: Joi.number().integer().min(0),
      writeRows: Joi.number().integer().min(0),
      currentOffset: Joi.string().trim().max(512).allow('', null),
      shardKey: Joi.string().trim().max(64),
      rateRowsPerSec: Joi.number().min(0),
      message: Joi.string().trim().max(1024).allow('', null),
      /** ---- 管道专属（契约 1.4 新字段，progress 恒 0、totalRows 为 null）---- */
      changeRows: Joi.number().integer().min(0),
      currentQps: Joi.number().min(0).allow(null),
      lagMs: Joi.number().min(0).allow(null),
      cdcPosition: Joi.string().trim().max(256).allow('', null),
      /** 实例回报也可携带触发方式（manual|cron|retry）：非空即回写实例，便于运维回溯 */
      trigger: Joi.string().valid(...TRIGGERS),
    })
    // 引擎回报属于内部链路，额外字段（如 shardKey 数组）直接忽略，避免打断进度上报
    .unknown(true)
    .required(),
};

const logs = {
  body: Joi.object()
    .keys({
      instanceId: Joi.string().trim().max(64).required(),
      logs: Joi.array()
        .items(
          Joi.object()
            .keys({
              level: Joi.string().valid(...LOG_LEVELS).insensitive(true),
              message: Joi.string().trim().max(2000).required(),
              timestamp: Joi.string().trim().max(64),
              createdAt: Joi.string().trim().max(64),
              taskId: Joi.string().trim().max(64),
            })
            .unknown(true)
        )
        .max(500)
        .required(),
    })
    .required(),
};

module.exports = {
  report,
  logs,
};
