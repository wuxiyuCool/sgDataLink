/**
 * 数据服务（Data API）管理层业务（docs/API.md 第 1.9 节，前缀 /api/v1/data-apis）。
 *
 * 职责边界：这里只管「定义 + 发布 + 统计 + 调试代理」，
 * 真正的对外网关（鉴权 / 白名单 / 限流 / mock 行）在 services/dataApiRuntime.service.js，
 * 调试接口 invokeDataApi 直接调用 runtime 的函数（不绕 HTTP 回环），
 * 因此前端拿到的 { httpStatus, body } 与外部调用 /ds/{path} 的响应完全一致。
 */
const crypto = require('crypto');
const pick = require('../utils/pick');
const dataApiRepository = require('../repositories/dataapi.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const taskInstanceService = require('./taskInstance.service');
const runtime = require('./dataApiRuntime.service');
const { paramInvalid, notFound } = require('../utils/bizError');
const { envelope } = require('../utils/apiResponse');
const { ERROR_CODES, BIZ_CODE_BY_HTTP_STATUS } = require('../config/errorCodes');

/** apiKey 前缀（契约示例 `dk-9f3a...`），后面接 32 位随机 hex */
const API_KEY_PREFIX = 'dk-';

const getOrThrow = (id) => {
  const api = dataApiRepository.getById(id);
  if (!api) throw notFound(`数据服务不存在: ${id}`);
  return api;
};

const normalizeBody = (body = {}) => {
  const payload = pick(body, [
    'name',
    'path',
    'method',
    'datasourceId',
    'tableName',
    'fields',
    'queryParams',
    'authEnabled',
    'rateLimitQps',
    'ipWhitelist',
    'remark',
  ]);
  if (payload.ipWhitelist) {
    payload.ipWhitelist = payload.ipWhitelist.map((item) => String(item).trim()).filter(Boolean);
  }
  if (payload.path) payload.path = String(payload.path).trim().replace(/^\/+/, '');
  return payload;
};

/** 定义校验：名称 / 路径唯一 / 数据源存在 / 至少一个返回字段（runtime 出数要按字段生成） */
const assertDefinition = (payload, self) => {
  if (!payload.name) throw paramInvalid('name 必填');
  if (!payload.path) throw paramInvalid('path 必填（对外地址是 /ds/{path}）');
  if (!payload.tableName) throw paramInvalid('tableName 必填');
  if (!payload.datasourceId) throw paramInvalid('datasourceId 必填');
  if (!datasourceRepository.getById(payload.datasourceId)) {
    throw paramInvalid(`datasourceId 对应的数据源不存在: ${payload.datasourceId}`);
  }
  if (!Array.isArray(payload.fields) || !payload.fields.length) {
    throw paramInvalid('fields 至少需要一个返回字段');
  }
  const occupied = dataApiRepository.findByPath(payload.path);
  if (occupied && (!self || occupied.id !== self.id)) {
    throw paramInvalid(`path 已被数据服务 ${occupied.id} 占用: ${payload.path}`);
  }
};

/** 分页列表：keyword / status / datasourceId / sort */
const queryDataApis = (filter = {}, options = {}) =>
  dataApiRepository.page({
    filters: { status: filter.status, datasourceId: filter.datasourceId, method: filter.method },
    keyword: filter.keyword,
    sort: options.sort,
    page: options.page,
    size: options.size,
  });

const getDataApiById = (id) => getOrThrow(id);

const createDataApi = (body) => {
  const payload = normalizeBody(body);
  assertDefinition(payload);
  return dataApiRepository.create({
    method: 'GET',
    queryParams: [],
    authEnabled: true,
    rateLimitQps: 20,
    ipWhitelist: [],
    ...payload,
    status: 'draft',
    apiKey: null,
    invokeCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
  });
};

const updateDataApiById = (id, body) => {
  const existing = getOrThrow(id);
  const payload = normalizeBody(body);
  if ('name' in payload && !payload.name) throw paramInvalid('name 必填');
  if (Object.keys(payload).length) {
    assertDefinition({ ...existing, ...payload }, existing);
  }
  // running 语义：已发布的 API 改 path 会让旧地址立刻 404，这里只做提示性的重复校验（见 assertDefinition）
  return dataApiRepository.update(id, payload);
};

const deleteDataApiById = (id) => {
  const existing = getOrThrow(id);
  dataApiRepository.delete(existing.id);
  runtime.rateWindow.reset(existing.id);
  return existing;
};

/** 生成 apiKey：`dk-` + 32 位随机 hex（Node 内置 crypto，不引依赖） */
const generateApiKey = () => `${API_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

/**
 * POST /data-apis/:id/publish —— 发布：生成（或保留）apiKey 并置 published。
 * 已发布时重复调用视为幂等：沿用原 key，避免把外部已接入的调用方打断。
 */
const publishDataApi = (id) => {
  const existing = getOrThrow(id);
  const apiKey = existing.apiKey || generateApiKey();
  return dataApiRepository.update(id, {
    status: 'published',
    apiKey,
    publishedAt: existing.publishedAt || new Date().toISOString(),
  });
};

/** POST /data-apis/:id/unpublish —— 下线：状态回 draft，运行时立刻 404（key 保留便于再发布） */
const unpublishDataApi = (id) => {
  const existing = getOrThrow(id);
  runtime.rateWindow.reset(existing.id);
  return dataApiRepository.update(id, { status: 'draft' });
};

/**
 * POST /data-apis/:id/invoke —— 前端「调试」按钮代理：
 * 服务端内部直接调 runtime（不经 HTTP），把结果与错误信封原样透传出来。
 * apiKey 取值规则：调用方没带（undefined）时用服务端已存的 key —— 浏览器本来就拿不到 key，
 * 调试要能出数；显式传入（含空串）则以入参为准，便于前端复现 40101（缺 key）/ 40102（无效 key）。
 * @param {string} id
 * @param {Object} input { query, apiKey, ip }
 * @returns {{ httpStatus: number, body: Object }}
 */
const invokeDataApi = (id, input = {}) => {
  const record = dataApiRepository.getById(id);
  const ctx = {
    apiKey: input.apiKey === undefined && record ? record.apiKey : input.apiKey,
    ip: input.ip,
    query: input.query || {},
  };
  try {
    const result = runtime.invokeById(id, ctx);
    return { httpStatus: 200, body: envelope(result) };
  } catch (err) {
    const httpStatus = err.statusCode || 500;
    return {
      httpStatus,
      body: {
        code: err.bizCode || BIZ_CODE_BY_HTTP_STATUS[httpStatus] || ERROR_CODES.INTERNAL_ERROR,
        message: err.message,
        result: null,
        timestamp: Date.now(),
      },
    };
  }
};

/**
 * GET /data-apis/:id/stats —— 调用统计。
 * recentTrend 与运维大盘同口径（UTC 日期、固定最近 7 天），数据来自内存调用日志。
 * 趋势项键名与顶层保持一致：{ date, count, errorCount, avgLatencyMs }
 * （仓储内部日志桶用的是 errors，这里出参统一改成 errorCount，避免前端两套命名）。
 */
const getStats = (id) => {
  const api = getOrThrow(id);
  const buckets = dataApiRepository.getCallLog(id);
  const trendMap = new Map(
    taskInstanceService.recentDates().map((date) => [date, { date, count: 0, errorCount: 0, avgLatencyMs: 0, latencySum: 0 }])
  );
  buckets.forEach((bucket) => {
    const item = trendMap.get(bucket.date);
    if (!item) return;
    item.count += bucket.count;
    item.errorCount += bucket.errors;
    item.latencySum += bucket.latencySum || 0;
  });
  const recentTrend = Array.from(trendMap.values()).map(({ latencySum, ...item }) => ({
    ...item,
    avgLatencyMs: item.count ? Number((latencySum / item.count).toFixed(2)) : 0,
  }));

  return {
    id: api.id,
    name: api.name,
    path: api.path,
    status: api.status,
    invokeCount: api.invokeCount || 0,
    errorCount: api.errorCount || 0,
    avgLatencyMs: api.avgLatencyMs || 0,
    runtimeUrl: `/ds/${api.path}`,
    recentTrend,
  };
};

module.exports = {
  API_KEY_PREFIX,
  generateApiKey,
  queryDataApis,
  getDataApiById,
  getDataApiOrThrow: getOrThrow,
  createDataApi,
  updateDataApiById,
  deleteDataApiById,
  publishDataApi,
  unpublishDataApi,
  invokeDataApi,
  getStats,
};
