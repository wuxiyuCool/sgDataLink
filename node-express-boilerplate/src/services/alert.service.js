/**
 * 告警触发链路（docs/API.md 第 1.10 节）。
 *
 * Mock 阶段的「真实部分」是判定与投递记录：
 * - 实例 failed                   → condition=task_failed
 * - 管道 failed / 写入 lastError   → condition=pipeline_error
 * - 管道 lagMs > thresholdLagMs    → condition=lag_over_threshold（同管道 + 同规则 60s 去重）
 * 命中 enabled 规则后，为每个 channel 写一条 alert-record，channelResult 固定 'mock-sent'，
 * **不发真实 webhook**（第二阶段在投递实现里换成钉钉 / 企微 / 邮件机器人并回填投递结果）。
 */
const pick = require('../utils/pick');
const logger = require('../config/logger');
const alertruleRepository = require('../repositories/alertrule.repository');
const alertrecordRepository = require('../repositories/alertrecord.repository');
const { paramInvalid, notFound } = require('../utils/bizError');

/** 契约 1.10 的三种触发条件 */
const CONDITIONS = ['task_failed', 'pipeline_error', 'lag_over_threshold'];

/** 条件对应的默认级别：延迟超标是可恢复的，按 WARN；其余 ERROR */
const LEVEL_BY_CONDITION = { task_failed: 'ERROR', pipeline_error: 'ERROR', lag_over_threshold: 'WARN' };

/** 同一管道 + 同一规则的延迟告警去重窗口（引擎每 tick 回报，不去重会刷屏） */
const LAG_DEDUPE_MS = 60 * 1000;

/** 内存里最多保留的告警记录数，超出后丢弃最旧的 */
const MAX_RECORDS = 1000;

/** `${ruleId}:${targetId}` -> 最近一次投递时间戳，只服务于 lag 去重 */
const lastLagAlertAt = new Map();

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

/**
 * 规则 scope 是否覆盖本次告警目标。
 * scope 支持 'all' | 'task' | 'dataflow' | 'pipeline'（写成数组也可以）；
 * 'task' 兼容只按条件配置的旧数据，同时覆盖 task 与 dataflow 两种运行体。
 */
const scopeMatches = (rule, targetType) => {
  const scope = rule.scope === undefined || rule.scope === null || rule.scope === '' ? 'all' : rule.scope;
  if (scope === 'all') return true;
  if (Array.isArray(scope)) return scope.includes(targetType);
  if (scope === 'task') return targetType === 'task' || targetType === 'dataflow';
  return scope === targetType;
};

/** 条件 + 阈值是否命中（lag_over_threshold 要求 lagMs 超过规则的 thresholdLagMs） */
const conditionMatches = (rule, event) => {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (!conditions.includes(event.condition)) return false;
  if (event.condition !== 'lag_over_threshold') return true;
  const threshold = toNumber(rule.thresholdLagMs);
  return threshold > 0 && toNumber(event.lagMs) > threshold;
};

/** lag 告警去重：同一规则对同一管道 60s 内只投一次 */
const lagDuplicated = (rule, event, nowMs) => {
  if (event.condition !== 'lag_over_threshold') return false;
  const key = `${rule.id}:${event.targetId}`;
  const last = lastLagAlertAt.get(key) || 0;
  if (nowMs - last < LAG_DEDUPE_MS) return true;
  lastLagAlertAt.set(key, nowMs);
  return false;
};

/** 记录数兜底淘汰：内存阶段也要防止长时间运行把告警中心撑爆 */
const pruneRecords = () => {
  const total = alertrecordRepository.count();
  if (total <= MAX_RECORDS) return;
  alertrecordRepository
    .find({ sort: 'createdAt:asc' })
    .slice(0, total - MAX_RECORDS)
    .forEach((record) => alertrecordRepository.delete(record.id));
};

/** 实例归属的目标类型：df- 前缀是数据开发，其余是同步任务（管道走 onPipelineFailed） */
const targetTypeOf = (instance) => (String((instance && instance.taskId) || '').startsWith('df-') ? 'dataflow' : 'task');

/**
 * 触发一次告警判定，返回写入的记录条数（供 engineReport 打日志）。
 * @param {Object} event {
 *   condition: 'task_failed'|'pipeline_error'|'lag_over_threshold',
 *   targetType: 'task'|'dataflow'|'pipeline', targetId, targetName, message, lagMs
 * }
 */
const fireEvent = (event = {}) => {
  if (!CONDITIONS.includes(event.condition)) {
    logger.warn('alert ignored: unknown condition %s', event.condition);
    return 0;
  }
  const nowMs = Date.now();
  const rules = alertruleRepository
    .findEnabled()
    .filter((rule) => scopeMatches(rule, event.targetType))
    .filter((rule) => conditionMatches(rule, event))
    .filter((rule) => !lagDuplicated(rule, event, nowMs));

  if (!rules.length) return 0;

  const created = [];
  rules.forEach((rule) => {
    const channels = Array.isArray(rule.channels) ? rule.channels : [];
    // 规则没配通道时仍写一条 channel='none' 的记录，否则告警中心看不到这次触发
    const targets = channels.length ? channels : [{ type: 'none', webhook: null }];
    targets.forEach((channel) => {
      created.push(
        alertrecordRepository.create({
          ruleId: rule.id,
          ruleName: rule.name,
          level: LEVEL_BY_CONDITION[event.condition] || 'ERROR',
          targetType: event.targetType,
          targetId: event.targetId,
          targetName: event.targetName || event.targetId,
          message: event.message || `${event.condition} 触发`,
          channel: (channel && channel.type) || 'none',
          channelResult: 'mock-sent',
          read: false,
          createdAt: new Date(nowMs).toISOString(),
        })
      );
    });
    logger.info(
      'alert fired: rule=%s condition=%s target=%s(%s)',
      rule.id,
      event.condition,
      event.targetType,
      event.targetId
    );
  });

  pruneRecords();
  return created.length;
};

/** 同步任务 / 数据开发实例失败（condition=task_failed） */
const onInstanceFailed = (instance, message) =>
  fireEvent({
    condition: 'task_failed',
    targetType: targetTypeOf(instance),
    targetId: instance && instance.taskId,
    targetName: instance && instance.taskName,
    message: message || (instance && instance.message) || '实例运行失败',
  });

/** 管道失败并写入 lastError（condition=pipeline_error） */
const onPipelineFailed = (pipeline, message) =>
  fireEvent({
    condition: 'pipeline_error',
    targetType: 'pipeline',
    targetId: pipeline && pipeline.id,
    targetName: pipeline && pipeline.name,
    message: message || (pipeline && pipeline.lastError) || '数据管道异常终止',
  });

/** 管道延迟超阈值（condition=lag_over_threshold，同管道 60s 去重） */
const onPipelineLag = (pipeline, lagMs) =>
  fireEvent({
    condition: 'lag_over_threshold',
    targetType: 'pipeline',
    targetId: pipeline && pipeline.id,
    targetName: pipeline && pipeline.name,
    lagMs,
    message: `数据管道 ${pipeline && pipeline.name} 同步延迟 ${toNumber(lagMs)}ms，已超过告警阈值`,
  });

/** ---- 管理端读写：/alert-rules CRUD 与 /alert-records 查询、标记已读 ---- */

const getRuleOrThrow = (id) => {
  const rule = alertruleRepository.getById(id);
  if (!rule) throw notFound(`告警规则不存在: ${id}`);
  return rule;
};

const queryRules = (filter = {}, options = {}) =>
  alertruleRepository.page({
    filters: { scope: filter.scope, enabled: filter.enabled },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getRuleById = (id) => getRuleOrThrow(id);

const createRule = (body = {}) => {
  const payload = pick(body, ['name', 'scope', 'conditions', 'thresholdLagMs', 'channels', 'enabled', 'remark']);
  if (!payload.name) throw paramInvalid('name 必填');
  if (!Array.isArray(payload.conditions) || !payload.conditions.length) {
    throw paramInvalid(`conditions 至少选择一个条件（${CONDITIONS.join('|')}）`);
  }
  const unknown = payload.conditions.filter((item) => !CONDITIONS.includes(item));
  if (unknown.length) throw paramInvalid(`conditions 存在未知取值: ${unknown.join(',')}`);
  return alertruleRepository.create({ scope: 'all', thresholdLagMs: 5000, channels: [], ...payload });
};

const updateRuleById = (id, body = {}) => {
  const existing = getRuleOrThrow(id);
  const payload = pick(body, ['name', 'scope', 'conditions', 'thresholdLagMs', 'channels', 'enabled', 'remark']);
  if ('name' in payload && !payload.name) throw paramInvalid('name 必填');
  const conditions = payload.conditions || existing.conditions;
  if (!Array.isArray(conditions) || !conditions.length) throw paramInvalid('conditions 至少选择一个条件');
  if (payload.conditions) {
    const unknown = payload.conditions.filter((item) => !CONDITIONS.includes(item));
    if (unknown.length) throw paramInvalid(`conditions 存在未知取值: ${unknown.join(',')}`);
  }
  return alertruleRepository.update(id, payload);
};

const deleteRuleById = (id) => {
  const existing = getRuleOrThrow(id);
  alertruleRepository.delete(existing.id);
  return existing;
};

/** GET /alert-records —— 支持 level / read / targetType / targetId / ruleId / keyword */
const queryRecords = (filter = {}, options = {}) =>
  alertrecordRepository.page({
    filters: {
      level: filter.level,
      read: filter.read,
      targetType: filter.targetType,
      targetId: filter.targetId,
      ruleId: filter.ruleId,
    },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

/** GET /alert-records/:id */
const getRecordById = (id) => {
  const record = alertrecordRepository.getById(id);
  if (!record) throw notFound(`告警记录不存在: ${id}`);
  return record;
};

/** PATCH /alert-records/:id/read */
const markRecordRead = (id) => {
  const existing = getRecordById(id);
  return alertrecordRepository.markRead(existing.id);
};

module.exports = {
  CONDITIONS,
  LEVEL_BY_CONDITION,
  LAG_DEDUPE_MS,
  MAX_RECORDS,
  scopeMatches,
  conditionMatches,
  targetTypeOf,
  fireEvent,
  onInstanceFailed,
  onPipelineFailed,
  onPipelineLag,
  queryRules,
  getRuleById,
  createRule,
  updateRuleById,
  deleteRuleById,
  queryRecords,
  markRecordRead,
  /** 单测 / 进程重启时清掉 lag 去重状态 */
  resetLagDedupe: () => lastLagAlertAt.clear(),
};
