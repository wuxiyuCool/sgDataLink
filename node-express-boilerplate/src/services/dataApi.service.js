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
const config = require('../config/config');
const dataQuery = require('../db/dataQuery');
const sqlGuard = require('../db/sqlGuard');
const dataApiRepository = require('../repositories/dataapi.repository');
const datasourceRepository = require('../repositories/datasource.repository');
const taskInstanceService = require('./taskInstance.service');
const runtime = require('./dataApiRuntime.service');
const { paramInvalid, notFound } = require('../utils/bizError');
const { envelope } = require('../utils/apiResponse');
const { ERROR_CODES, BIZ_CODE_BY_HTTP_STATUS } = require('../config/errorCodes');

/** apiKey 前缀（契约示例 `dk-9f3a...`），后面接 32 位随机 hex */
const API_KEY_PREFIX = 'dk-';

/** 契约 1.9.2 允许的自定义 SQL 参数类型（boolean 只有 builder 用） */
const CUSTOM_PARAM_TYPES = ['string', 'number', 'date', 'list'];

/**
 * DB_DRIVER=memory（演示模式）下的内置元数据（1.9.1）：
 * 与 seed 里的 T_ORDER / T_ORDER_MIRROR 叙事保持一致，前端下拉与联调不至于空手。
 */
const MEMORY_META_TABLES = [
  { name: 'T_ORDER', comment: '订单主表（演示）' },
  { name: 'T_ORDER_ITEM', comment: '订单明细（演示）' },
];

const MEMORY_META_COLUMNS = {
  T_ORDER: [
    { name: 'ID', type: 'BIGINT', nullable: false, comment: '主键' },
    { name: 'ORDER_NO', type: 'VARCHAR(32)', nullable: false, comment: '订单号' },
    { name: 'CUSTOMER_NAME', type: 'VARCHAR(64)', nullable: true, comment: '客户名' },
    { name: 'AMOUNT', type: 'DECIMAL(18,2)', nullable: true, comment: '金额' },
    { name: 'STATUS', type: 'VARCHAR(16)', nullable: true, comment: '状态' },
    { name: 'CREATED_AT', type: 'DATETIME', nullable: true, comment: '创建时间' },
  ],
  T_ORDER_ITEM: [
    { name: 'ID', type: 'BIGINT', nullable: false, comment: '主键' },
    { name: 'ORDER_ID', type: 'BIGINT', nullable: false, comment: '订单主表外键' },
    { name: 'SKU', type: 'VARCHAR(64)', nullable: true, comment: '商品编码' },
    { name: 'QTY', type: 'INT', nullable: true, comment: '数量' },
    { name: 'PRICE', type: 'DECIMAL(18,2)', nullable: true, comment: '单价' },
  ],
};

const getOrThrow = async (id) => {
  const api = await dataApiRepository.getById(id);
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
    'sqlMode',
    'customSql',
    'authEnabled',
    'rateLimitQps',
    'ipWhitelist',
    'remark',
  ]);
  if (payload.ipWhitelist) {
    payload.ipWhitelist = payload.ipWhitelist.map((item) => String(item).trim()).filter(Boolean);
  }
  if (payload.path) payload.path = String(payload.path).trim().replace(/^\/+/, '');
  if (payload.customSql !== undefined) payload.customSql = String(payload.customSql || '').trim();
  return payload;
};

/** sqlMode 缺省按 builder（契约：builder 是默认模式） */
const sqlModeOf = (api = {}) => (api.sqlMode === 'custom' ? 'custom' : 'builder');

/**
 * custom 模式的定义校验（契约 1.9.2 保存期红线）：
 * 1) customSql 必填 + 只读（assertReadOnly：SELECT/WITH 开头、禁多语句、关键字黑名单）；
 * 2) SQL 里的 :name 占位符集合 ⊆ queryParams 名单（多出来的参数只当未使用，不报错）；
 * 3) queryParams[].type ∈ string|number|date|list，参数名不得重复。
 * @returns {{ placeholders: string[] }}
 */
const assertCustomSql = (payload) => {
  const sql = String(payload.customSql || '').trim();
  if (!sql) throw paramInvalid('sqlMode=custom 时 customSql 必填');
  const guard = sqlGuard.assertReadOnly(sql);
  if (!guard.ok) throw paramInvalid(`customSql: ${guard.reason}`);
  const declared = Array.isArray(payload.queryParams) ? payload.queryParams : [];
  const names = declared.map((p) => p && p.name);
  const duplicated = names.filter((name, index) => name && names.indexOf(name) !== index);
  if (duplicated.length) throw paramInvalid(`queryParams 参数名重复: ${Array.from(new Set(duplicated)).join(', ')}`);
  declared.forEach((p) => {
    if (!CUSTOM_PARAM_TYPES.includes(p.type)) {
      throw paramInvalid(`queryParams[${p.name}].type 仅支持 ${CUSTOM_PARAM_TYPES.join('|')}，当前: ${p.type}`);
    }
  });
  const placeholders = sqlGuard.extractPlaceholders(sql);
  const unknown = placeholders.filter((name) => !names.includes(name));
  if (unknown.length) {
    throw paramInvalid(`customSql 占位符未在 queryParams 声明: ${unknown.map((n) => `:${n}`).join(', ')}`);
  }
  return { placeholders };
};

/** 定义校验：名称 / 路径唯一 / 数据源存在 / 按 sqlMode 分别校验 builder 与 custom */
const assertDefinition = async (payload, self) => {
  if (!payload.name) throw paramInvalid('name 必填');
  if (!payload.path) throw paramInvalid('path 必填（对外地址是 /ds/{path}）');
  if (!payload.datasourceId) throw paramInvalid('datasourceId 必填');
  if (!(await datasourceRepository.getById(payload.datasourceId))) {
    throw paramInvalid(`datasourceId 对应的数据源不存在: ${payload.datasourceId}`);
  }
  if (sqlModeOf(payload) === 'custom') {
    assertCustomSql(payload);
  } else {
    // builder：维持现状 —— 表名 + 至少一个返回字段（runtime 出数要按字段生成）
    if (!payload.tableName) throw paramInvalid('tableName 必填');
    if (!Array.isArray(payload.fields) || !payload.fields.length) {
      throw paramInvalid('fields 至少需要一个返回字段');
    }
  }
  const occupied = await dataApiRepository.findByPath(payload.path);
  if (occupied && (!self || occupied.id !== self.id)) {
    throw paramInvalid(`path 已被数据服务 ${occupied.id} 占用: ${payload.path}`);
  }
};

/**
 * 1.9.1 元数据浏览：真实模式（DB_DRIVER=mysql）按绑定数据源查 information_schema / ALL_*，
 * 演示模式（memory）返回内置表。数据源不存在 → 40401。
 * @param {Object} input { datasourceId, keyword }
 */
const listMetaTables = async ({ datasourceId, keyword } = {}) => {
  if (!datasourceId) throw paramInvalid('datasourceId 必填');
  const ds = await datasourceRepository.getById(datasourceId);
  if (!ds) throw notFound(`数据源不存在: ${datasourceId}`);
  if (!config.db.isMysql()) {
    const text = String(keyword || '').trim().toUpperCase();
    return text ? MEMORY_META_TABLES.filter((item) => item.name.includes(text)) : MEMORY_META_TABLES;
  }
  return dataQuery.listTables(ds, keyword);
};

/**
 * 1.9.1 列清单。真实模式由 dataQuery 侧过 IDENT_RE 白名单 + 全绑定参数查询。
 * @param {Object} input { datasourceId, tableName }
 */
const listMetaColumns = async ({ datasourceId, tableName } = {}) => {
  if (!datasourceId) throw paramInvalid('datasourceId 必填');
  if (!tableName) throw paramInvalid('tableName 必填');
  const ds = await datasourceRepository.getById(datasourceId);
  if (!ds) throw notFound(`数据源不存在: ${datasourceId}`);
  if (!config.db.isMysql()) {
    const key = String(tableName).toUpperCase().split('.').pop();
    const columns = MEMORY_META_COLUMNS[key];
    if (!columns) return [];
    return columns;
  }
  return dataQuery.listColumns(ds, tableName);
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

const createDataApi = async (body) => {
  const payload = normalizeBody(body);
  await assertDefinition(payload);
  return dataApiRepository.create({
    method: 'GET',
    queryParams: [],
    sqlMode: 'builder',
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

const updateDataApiById = async (id, body) => {
  const existing = await getOrThrow(id);
  const payload = normalizeBody(body);
  if ('name' in payload && !payload.name) throw paramInvalid('name 必填');
  if (Object.keys(payload).length) {
    await assertDefinition({ ...existing, ...payload }, existing);
  }
  // running 语义：已发布的 API 改 path 会让旧地址立刻 404，这里只做提示性的重复校验（见 assertDefinition）
  return dataApiRepository.update(id, payload);
};

const deleteDataApiById = async (id) => {
  const existing = await getOrThrow(id);
  await dataApiRepository.delete(existing.id);
  runtime.rateWindow.reset(existing.id);
  return existing;
};

/** 生成 apiKey：`dk-` + 32 位随机 hex（Node 内置 crypto，不引依赖） */
const generateApiKey = () => `${API_KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;

/**
 * POST /data-apis/:id/publish —— 发布：生成（或保留）apiKey 并置 published。
 * 已发布时重复调用视为幂等：沿用原 key，避免把外部已接入的调用方打断。
 */
const publishDataApi = async (id) => {
  const existing = await getOrThrow(id);
  // 发布是「对外可达」的开关，这里再跑一次定义校验：直接改库把 customSql 换掉的场景也会被拦下
  if (sqlModeOf(existing) === 'custom') assertCustomSql(existing);
  else if (!existing.tableName || !(existing.fields || []).length) {
    throw paramInvalid('builder 模式需要 tableName 与 fields 才能发布');
  }
  const apiKey = existing.apiKey || generateApiKey();
  return dataApiRepository.update(id, {
    status: 'published',
    apiKey,
    publishedAt: existing.publishedAt || new Date().toISOString(),
  });
};

/** POST /data-apis/:id/unpublish —— 下线：状态回 draft，运行时立刻 404（key 保留便于再发布） */
const unpublishDataApi = async (id) => {
  const existing = await getOrThrow(id);
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
const invokeDataApi = async (id, input = {}) => {
  const record = await dataApiRepository.getById(id);
  const ctx = {
    apiKey: input.apiKey === undefined && record ? record.apiKey : input.apiKey,
    ip: input.ip,
    query: input.query || {},
  };
  try {
    const result = await runtime.invokeById(id, ctx);
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
 * recentTrend 与运维大盘同口径（UTC 日期、固定最近 7 天），
 * 数据来自仓储的按天调用日志（内存版是模块级 Map，mysql 版是 databridge_data_api_call_day 表）。
 * 趋势项键名与顶层保持一致：{ date, count, errorCount, avgLatencyMs }
 * （仓储内部日志桶用的是 errors，这里出参统一改成 errorCount，避免前端两套命名）。
 */
const getStats = async (id) => {
  const api = await getOrThrow(id);
  const buckets = await dataApiRepository.getCallLog(id);
  const trendMap = new Map(
    taskInstanceService
      .recentDates()
      .map((date) => [date, { date, count: 0, errorCount: 0, avgLatencyMs: 0, latencySum: 0 }])
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
  CUSTOM_PARAM_TYPES,
  MEMORY_META_TABLES,
  MEMORY_META_COLUMNS,
  generateApiKey,
  queryDataApis,
  getDataApiById,
  getDataApiOrThrow: getOrThrow,
  sqlModeOf,
  assertCustomSql,
  listMetaTables,
  listMetaColumns,
  createDataApi,
  updateDataApiById,
  deleteDataApiById,
  publishDataApi,
  unpublishDataApi,
  invokeDataApi,
  getStats,
};
