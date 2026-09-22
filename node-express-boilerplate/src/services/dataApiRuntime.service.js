/**
 * 数据服务（Data API）运行时网关（docs/API.md 第 1.9 节，对外端点 GET /ds/{path}）。
 *
 * 契约要点：**鉴权 / 白名单 / 限流是真实生效的**，只有返回的数据行是 mock：
 *   1) path 找不到或未发布         → 404 / 40404
 *   2) authEnabled 且缺 X-API-Key  → 401 / 40101；Key 不匹配 → 401 / 40102
 *   3) ipWhitelist 非空且不含来源 IP → 403 / 40301
 *   4) 1s 窗口内计数 >= rateLimitQps → 429 / 42901
 *   5) 通过 → 确定性 mock 行（种子 tableName|page|size），并累加 invokeCount/errorCount/avgLatencyMs
 *
 * 失败一律抛带 bizCode 的 ApiError，由全局 errorHandler 渲染成统一信封 + 契约要求的 HTTP 状态码；
 * 管理端 POST /data-apis/:id/invoke 直接复用 invokeById（不经 HTTP 回环），
 * 把结果或错误信封原样透传给前端的「调试」按钮。
 */
const { performance } = require('perf_hooks');
const logger = require('../config/logger');
const dataApiRepository = require('../repositories/dataapi.repository');
const { generateRows } = require('../utils/mockRows');
const { createRateWindow } = require('../utils/rateWindow');
const { dataApiNotFound, apiKeyMissing, apiKeyInvalid, ipNotWhitelisted, rateLimitExceeded } = require('../utils/bizError');

/** 契约：apiKey 走 X-API-Key 头，也允许 query 里带 apiKey（方便浏览器直接试） */
const API_KEY_HEADER = 'x-api-key';
const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 20;
const MAX_SIZE = 500;

/** 进程级滑动窗口限流器（1s 窗口），key = dataApi id */
const rateWindow = createRateWindow();

const toInt = (value, fallback) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : fallback;
};

/** 去掉 IPv4-mapped IPv6 前缀，便于和白名单里的四段地址比对 */
const normalizeIp = (ip) => {
  const text = String(ip || '').trim();
  return text.startsWith('::ffff:') ? text.slice(7) : text;
};

/**
 * 取来源 IP：优先 x-forwarded-for 的第一跳（上游代理追加），再 x-real-ip，最后 req.ip。
 * 本服务没有开 express 的 trust proxy，所以这里自己解析，避免 req.ip 永远是代理地址。
 */
const clientIpOf = (req = {}) => {
  const headers = req.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim();
  const ip = first || headers['x-real-ip'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  return normalizeIp(ip);
};

/** 白名单比对：完全相等，或规则以 `*` 结尾时按前缀匹配（如 `10.0.0.*`）；IPv6 环回视为 127.0.0.1 */
const ipAllowed = (whitelist, ip) => {
  const target = normalizeIp(ip);
  if (!target) return false;
  if (target === '::1') return whitelist.some((item) => ['::1', '127.0.0.1', 'localhost'].includes(normalizeIp(item)));
  return whitelist.some((item) => {
    const rule = normalizeIp(item);
    if (!rule) return false;
    if (rule === target) return true;
    return rule.endsWith('*') ? target.startsWith(rule.slice(0, -1)) : false;
  });
};

/** 从 query 里取 page / size（契约提到也支持 limit 别名） */
const resolvePaging = (query = {}) => {
  const page = Math.max(toInt(query.page, DEFAULT_PAGE), 1);
  const rawSize = query.size !== undefined ? query.size : query.limit;
  const size = Math.min(Math.max(toInt(rawSize, DEFAULT_SIZE), 1), MAX_SIZE);
  return { page, size };
};

/** 依次执行鉴权 → 白名单 → 限流，任一不通过抛对应业务码 */
const assertAccessible = (api, ctx) => {
  if (api.authEnabled) {
    const key = ctx.apiKey || (ctx.query && ctx.query.apiKey);
    if (!key) throw apiKeyMissing(`未提供 API Key（请用 ${API_KEY_HEADER.toUpperCase()} 头或 apiKey 查询参数携带）`);
    if (!api.apiKey || String(key) !== String(api.apiKey)) throw apiKeyInvalid('API Key 无效');
  }
  const whitelist = Array.isArray(api.ipWhitelist) ? api.ipWhitelist.filter(Boolean) : [];
  if (whitelist.length && !ipAllowed(whitelist, ctx.ip)) {
    throw ipNotWhitelisted(`来源 IP 不在白名单内: ${ctx.ip || 'unknown'}`);
  }
  const { allowed, count } = rateWindow.check(String(api.id), Number(api.rateLimitQps));
  if (!allowed) {
    throw rateLimitExceeded(`超过限流阈值 rateLimitQps=${api.rateLimitQps}（当前 1s 窗口已放行 ${count} 次）`);
  }
};

/** 1.9 的成功响应 result：{ fields: ['ID','AMOUNT'], rows: [[...]], total, page, size } */
const buildResult = (api, query = {}) => {
  const { page, size } = resolvePaging(query);
  const { fields, rows, total } = generateRows({ tableName: api.tableName, fields: api.fields || [], page, size });
  return { fields, rows, total, page, size };
};

/**
 * 网关主流程：校验 + 出数据 + 记统计（延迟用 performance.now 实测）。
 * 被拒的请求同样计入 invokeCount / errorCount，因为「确实有人打过来了」。
 * 统计写入是 await 的（mysql 驱动下要落库），但失败只记 WARN ——
 * 不能让一次统计写失败把已经算好的数据行或原本的业务错误码换掉。
 * @param {Object} api dataApi 记录（必须已发布）
 * @param {Object} ctx { apiKey, ip, query }
 * @returns {Promise<Object>} 1.9 的成功响应 result
 */
const serve = async (api, ctx = {}) => {
  const started = performance.now();
  const query = ctx.query || {};
  let ok = true;
  try {
    assertAccessible(api, { ...ctx, query });
    return buildResult(api, query);
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    try {
      await dataApiRepository.recordCall(api.id, { latencyMs, ok });
      logger.debug('data api %s(%s) served ok=%s in %sms', api.id, api.path, ok, latencyMs);
    } catch (err) {
      logger.warn('data api %s recordCall failed: %s', api.id, err.message);
    }
  }
};

/**
 * 运行时入口：GET /ds/:path。path 不存在或未发布 → 404 / 40404（不暴露是否存在，统一文案）。
 */
const invokeByPath = async (path, ctx = {}) => {
  const api = await dataApiRepository.findByPath(path);
  if (!api || api.status !== 'published') {
    throw dataApiNotFound(`数据服务不存在或未发布: /ds/${path}`);
  }
  return serve(api, ctx);
};

/** 管理端「调试」入口：按 id 走同一套网关逻辑 */
const invokeById = async (id, ctx = {}) => {
  const api = await dataApiRepository.getById(id);
  if (!api) throw dataApiNotFound(`数据服务不存在: ${id}`);
  if (api.status !== 'published') throw dataApiNotFound(`数据服务未发布，无法调用: ${api.path}`);
  return serve(api, ctx);
};

module.exports = {
  API_KEY_HEADER,
  DEFAULT_SIZE,
  MAX_SIZE,
  rateWindow,
  normalizeIp,
  clientIpOf,
  ipAllowed,
  resolvePaging,
  buildResult,
  assertAccessible,
  serve,
  invokeByPath,
  invokeById,
};
