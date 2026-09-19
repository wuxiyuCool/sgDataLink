const httpStatus = require('http-status');
const config = require('../config/config');
const logger = require('../config/logger');
const { engineUnavailable, engineRejected, duplicateStart, notFound } = require('./bizError');

/**
 * Go 同步引擎 HTTP 客户端（docs/API.md 第 2 节）。
 *
 * - 使用 Node 18+ 全局 fetch，超时 ENGINE_TIMEOUT_MS（默认 5s）。
 * - 网络失败 / 超时 / 响应不可解析 → ApiError 50001（HTTP 502）。
 * - 引擎返回 code != 0 → ApiError 50002；409 视为「已在运行」→ ApiError 40901。
 * - 引擎 404（stop 时实例不存在）→ ApiError 40401，由调用方决定是否忽略。
 *
 * 【第二阶段替换点】真实调度替换后仍走同一份接口，只是 baseUrl 指向真引擎服务名。
 */

const trimTrailingSlash = (url) => String(url || '').replace(/\/+$/, '');

const buildUrl = (path) => `${trimTrailingSlash(config.engine.baseUrl)}${path}`;

/**
 * POST 一段 JSON 到引擎，返回 { statusCode, body }。
 * 只在「通信层面」失败时抛错，HTTP 4xx/5xx 交给调用方判断语义。
 */
const postJson = async (path, payload) => {
  const url = buildUrl(path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.engine.timeoutMs);
  let response;
  try {
    if (typeof fetch !== 'function') {
      throw new Error('global fetch unavailable, please run on Node >= 18');
    }
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `请求超时(${config.engine.timeoutMs}ms)` : err.message;
    logger.warn('engine request failed: %s %s (%s)', 'POST', url, reason);
    throw engineUnavailable(`调用同步引擎失败: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  const text = await response.text().catch(() => '');
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    body = {};
  }

  return { statusCode: response.status, body: body || {} };
};

/**
 * 引擎信封 { code, message, data } 解包：非 0 视为业务失败。
 * @param {Object} res  { statusCode, body }
 * @param {string} fallbackMessage 兜底错误信息
 * @param {Object} [opts] opts.treatNotFoundAsRejected=true 时（start 场景）把 404 视为
 *                        引擎侧配置/路由问题（50002），而不是「资源不存在」
 */
const unwrap = (res, fallbackMessage, opts = {}) => {
  if (res.statusCode === httpStatus.CONFLICT || res.body.code === 40901) {
    throw duplicateStart(res.body.message || '该实例已在运行中，请勿重复启动');
  }
  if (res.statusCode === httpStatus.NOT_FOUND || res.body.code === 40401) {
    if (opts.treatNotFoundAsRejected) {
      throw engineRejected(res.body.message || `同步引擎接口不存在(${res.statusCode})，请检查 ENGINE_BASE_URL`);
    }
    throw notFound(res.body.message || '引擎中不存在该运行实例');
  }
  if (res.statusCode >= httpStatus.BAD_REQUEST && res.statusCode < httpStatus.INTERNAL_SERVER_ERROR) {
    throw engineRejected(res.body.message || `引擎拒绝请求(${res.statusCode})`);
  }
  if (res.statusCode >= httpStatus.INTERNAL_SERVER_ERROR) {
    throw engineRejected(res.body.message || `引擎内部错误(${res.statusCode})`);
  }
  if (res.body.code !== undefined && res.body.code !== 0) {
    throw engineRejected(res.body.message || fallbackMessage);
  }
  return res.body.data || {};
};

/**
 * 下发启动指令：POST {ENGINE_BASE_URL}/api/v1/engine/tasks/start
 * @param {Object} snapshot 任务快照，字段见 docs/API.md 第 2 节
 * @returns {Promise<Object>} 引擎 data
 */
const startTask = async (snapshot) => {
  logger.debug('engine start task: %s / %s', snapshot.taskId, snapshot.instanceId);
  const res = await postJson('/api/v1/engine/tasks/start', snapshot);
  return unwrap(res, '引擎启动任务失败', { treatNotFoundAsRejected: true });
};

/**
 * 下发停止指令：POST {ENGINE_BASE_URL}/api/v1/engine/tasks/stop
 * @param {string} instanceId
 * @returns {Promise<Object>} 引擎 data
 */
const stopTask = async (instanceId) => {
  logger.debug('engine stop task: %s', instanceId);
  const res = await postJson('/api/v1/engine/tasks/stop', { instanceId });
  return unwrap(res, '引擎停止任务失败');
};

/**
 * 下发数据管道（CDC）启动指令（docs/API.md 第 2 节「cdc 模式」+ 第 1.7 节）。
 *
 * 走的是同一个引擎 start 接口，只是快照里 taskId 恒为 null、syncMode=cdc，
 * 用 pipelineId + syncObjects 描述「整库/多表实时镜像」，totalRows 被引擎忽略。
 * 409（重复下发）与 404（引擎没有该路由）的语义与 startTask 完全一致。
 *
 * @param {Object} snapshot { instanceId, pipelineId, taskId:null, syncMode:'cdc',
 *                            syncObjects, batchSize, failureRate, reportUrl }
 * @returns {Promise<Object>} 引擎 data
 */
const startPipeline = async (snapshot) => {
  logger.debug('engine start pipeline: %s / %s', snapshot.pipelineId, snapshot.instanceId);
  const res = await postJson('/api/v1/engine/tasks/start', snapshot);
  return unwrap(res, '引擎启动管道失败', { treatNotFoundAsRejected: true });
};

/**
 * 引擎健康检查（前端「引擎在线状态」可选用），GET /health。
 * @returns {Promise<Object>}
 */
const health = async () => {
  const url = `${trimTrailingSlash(config.engine.baseUrl)}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.engine.timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    const text = await response.text();
    return { statusCode: response.status, body: text ? JSON.parse(text) : {} };
  } catch (err) {
    throw engineUnavailable(`调用同步引擎失败: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
};

module.exports = {
  startTask,
  startPipeline,
  stopTask,
  health,
  buildUrl,
};
