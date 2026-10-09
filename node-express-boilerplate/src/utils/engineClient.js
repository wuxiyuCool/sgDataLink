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
  const headers = { 'Content-Type': 'application/json' };
  // 契约 1.12：配置了 ENGINE_SHARED_SECRET 就必带 X-Engine-Token（引擎侧同值校验）
  if (config.engine.sharedSecret) headers['X-Engine-Token'] = config.engine.sharedSecret;
  let response;
  try {
    if (typeof fetch !== 'function') {
      throw new Error('global fetch unavailable, please run on Node >= 18');
    }
    response = await fetch(url, {
      method: 'POST',
      headers,
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

/**
 * 通用 SQL 查询（契约 2.5）：POST {engine}/api/v1/engine/sql/query。
 * endpoint 为真实数据源快照（含明文口令，只在进程间传输）；失败统一抛业务错误。
 * @param {Object} endpoint { id,type,host,port,database,username,password }
 * @param {string} sql 单条 SELECT
 * @param {Object} [opts] { limit, timeoutSec, sqlTimeout } —— sqlTimeout 给 unwrap 前
 *   的 HTTP 层放宽（默认 ENGINE_TIMEOUT_MS 太短，真实查询按 engineSqlTimeoutMs 走）
 */
const sqlQuery = async (endpoint, sql, opts = {}) => {
  const url = buildUrl('/api/v1/engine/sql/query');
  const timeoutMs = opts.timeoutMs || config.engine.sqlTimeoutMs || 35000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (config.engine.sharedSecret) headers['X-Engine-Token'] = config.engine.sharedSecret;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint,
        sql,
        limit: opts.limit || 1000,
        timeoutSec: opts.timeoutSec || 30,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `请求超时(${timeoutMs}ms)` : err.message;
    throw engineUnavailable(`调用引擎 SQL 查询失败: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    body = {};
  }
  if (body.code === 40101)
    throw engineRejected('引擎拒绝了 SQL 调用: X-Engine-Token 不匹配，请检查双侧 ENGINE_SHARED_SECRET');
  if (body.code !== undefined && body.code !== 0) {
    // 目标库执行失败(50002)等业务错误透传库消息，由调用方转 50201
    throw Object.assign(new Error(body.message || '引擎 SQL 查询失败'), { engineBizCode: body.code, engineBody: body });
  }
  return body.data || {};
};

/**
 * 通用 SQL 执行（契约 2.5）：POST {engine}/api/v1/engine/sql/exec，同步模式。
 * @param {Object} endpoint 真实数据源快照
 * @param {Array<string>} statements 白名单语句（CREATE/TRUNCATE/INSERT/ALTER ADD）
 */
const sqlExec = async (endpoint, statements, opts = {}) => {
  const url = buildUrl('/api/v1/engine/sql/exec');
  const timeoutMs = opts.timeoutMs || config.engine.sqlTimeoutMs || 35000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (config.engine.sharedSecret) headers['X-Engine-Token'] = config.engine.sharedSecret;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        instanceId: opts.instanceId || `mtr-${Date.now()}`,
        endpoint,
        statements,
        reportUrl: opts.reportUrl || undefined,
        /** 破坏性动词开闸：只有建模删除平台自建表时传 true（契约 v1.13） */
        allowDrop: opts.allowDrop === true || undefined,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `请求超时(${timeoutMs}ms)` : err.message;
    throw engineUnavailable(`调用引擎 SQL 执行失败: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    body = {};
  }
  if (body.code === 40101)
    throw engineRejected('引擎拒绝了 SQL 调用: X-Engine-Token 不匹配，请检查双侧 ENGINE_SHARED_SECRET');
  if (body.code !== undefined && body.code !== 0) {
    throw Object.assign(new Error(body.message || '引擎 SQL 执行失败'), { engineBizCode: body.code, engineBody: body });
  }
  return body.data || {};
};

module.exports = {
  startTask,
  startPipeline,
  stopTask,
  sqlQuery,
  sqlExec,
  health,
  buildUrl,
};
