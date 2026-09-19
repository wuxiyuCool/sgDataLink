const Joi = require('joi');

/**
 * 数据开发（ETL 画布）校验（docs/API.md 第 1.8 节）。
 *
 * 画布 JSON 做三层深校验：
 * 1) 结构：node.id/type/name/config、edge.source/target 必填，config 必须是对象（不能是数组/标量）；
 * 2) 语义：type 必须在组件枚举内、节点 id 不可重复、edges 只能引用已存在的节点 id；
 * 3) 可运行：至少一个 input 与一个 output（run 时取首尾 input/output 拼引擎 full 快照）。
 * 后两层里「id 重复」「input/output 的 datasourceId/table 是否有效」由
 * services/dataflow.service.js 再兜一次（统一 40001），因为它需要查数据源。
 */

const NODE_TYPES = ['input', 'output', 'filter', 'transform', 'join', 'union', 'sql', 'json_parse', 'validate'];
const LAST_STATUSES = ['idle', 'running', 'success', 'failed', 'stopped'];

const id = Joi.string().trim().max(64).required();

const node = Joi.object().keys({
  id: Joi.string().trim().min(1).max(64).required(),
  type: Joi.string().valid(...NODE_TYPES).required(),
  name: Joi.string().trim().max(128).allow('', null),
  // 组件参数：input/output 是 { datasourceId, table, writeMode }，filter/validate 是条件或规则数组
  config: Joi.object().unknown(true).required(),
});

const edge = Joi.object().keys({
  source: Joi.string().trim().min(1).max(64).required(),
  target: Joi.string().trim().min(1).max(64).required(),
});

/** 画布跨字段规则（挂在 body 上，因为要同时看 nodes 与 edges） */
const canvasRule = (value, helpers) => {
  const nodes = Array.isArray(value.nodes) ? value.nodes : null;
  const edges = Array.isArray(value.edges) ? value.edges : null;
  if (!nodes && !edges) return value;
  if (!nodes || !nodes.length) return helpers.message('画布至少需要一个 input 节点与一个 output 节点');

  const ids = new Set(nodes.map((item) => item && item.id));
  const dangling = (edges || []).find((item) => !ids.has(item.source) || !ids.has(item.target));
  if (dangling) {
    return helpers.message(`edges 引用了不存在的节点 id: ${dangling.source} -> ${dangling.target}`);
  }
  if (!nodes.some((item) => item.type === 'input')) return helpers.message('画布至少需要一个 input 节点');
  if (!nodes.some((item) => item.type === 'output')) return helpers.message('画布至少需要一个 output 节点');
  return value;
};

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  nodes: Joi.array().items(node).max(500),
  edges: Joi.array().items(edge).max(1000),
  // 调度字段与同步任务同构：cron 定时 + 失败重试次数 / 间隔
  scheduleCron: Joi.string().trim().max(64).allow(null),
  retryCount: Joi.number().integer().min(0).max(10),
  retryIntervalSec: Joi.number().integer().min(0).max(86400),
  enabled: Joi.boolean(),
  remark: Joi.string().trim().max(255).allow('', null),
  // 引擎按 full 模式模拟执行需要的量（非契约字段，缺省走 mock 默认值）
  totalRows: Joi.number().integer().min(0),
  failureRate: Joi.number().min(0).max(1),
};

const listDataflows = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      lastStatus: Joi.string().valid(...LAST_STATUSES),
      enabled: Joi.boolean(),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getDataflow = {
  params: Joi.object().keys({ id }),
};

const createDataflow = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      nodes: baseKeys.nodes.required().min(2),
      edges: baseKeys.edges.required(),
    })
    .required()
    .custom(canvasRule),
};

const updateDataflow = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1).custom(canvasRule),
};

const deleteDataflow = {
  params: Joi.object().keys({ id }),
};

/** run / stop 只带 id；trigger 供脚本调试，缺省 manual */
const runDataflow = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      trigger: Joi.string().valid('manual', 'cron', 'retry'),
    })
    .unknown(true),
};

const stopDataflow = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({ instanceId: Joi.string().trim().max(64) })
    .unknown(true),
};

const getDataflowProgress = {
  params: Joi.object().keys({ id }),
};

module.exports = {
  NODE_TYPES,
  canvasRule,
  listDataflows,
  getDataflow,
  createDataflow,
  updateDataflow,
  deleteDataflow,
  runDataflow,
  stopDataflow,
  getDataflowProgress,
};
