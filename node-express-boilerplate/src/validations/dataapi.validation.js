const Joi = require('joi');

/**
 * 数据服务（Data API）管理端校验（docs/API.md 第 1.9 节）。
 * 运行时端点 /ds/{path} 不在这套 schema 里（query 参数按定义动态变化，
 * 由 services/dataApiRuntime.service.js 自己解析 page/size/limit）。
 */

const STATUSES = ['draft', 'published'];
const METHODS = ['GET', 'POST'];
/** 声明的查询参数支持的类型（只影响前端渲染，不参与 mock 出数） */
const QUERY_TYPES = ['string', 'number', 'date', 'boolean'];
/** 返回字段类型：允许 SQL 风格带精度，如 DECIMAL(18,2) / VARCHAR2(200) */
const FIELD_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;
/** 白名单条目：IPv4（可带 * 后缀）、IPv6 字面量、localhost */
const IP_PATTERN = /^(\d{1,3}(\.\d{1,3}){3}\*?|[0-9a-fA-F:]{2,64}|localhost)$/;

const id = Joi.string().trim().max(64).required();

const field = Joi.object().keys({
  name: Joi.string().trim().min(1).max(128).required(),
  type: Joi.string().trim().max(64).regex(FIELD_TYPE_PATTERN).required(),
  remark: Joi.string().trim().max(255).allow('', null),
});

const queryParam = Joi.object().keys({
  name: Joi.string().trim().min(1).max(128).required(),
  type: Joi.string().valid(...QUERY_TYPES),
  required: Joi.boolean(),
  remark: Joi.string().trim().max(255).allow('', null),
});

const baseKeys = {
  name: Joi.string().trim().min(1).max(64),
  // path 决定对外地址 /ds/{path}：express 的 :path 只吃单段，因此不允许再带斜杠
  path: Joi.string()
    .trim()
    .min(1)
    .max(128)
    .pattern(/^[A-Za-z0-9._-]+$/),
  method: Joi.string().valid(...METHODS),
  datasourceId: Joi.string().trim().max(64),
  tableName: Joi.string().trim().max(128),
  fields: Joi.array().items(field).max(200),
  queryParams: Joi.array().items(queryParam).max(100),
  authEnabled: Joi.boolean(),
  rateLimitQps: Joi.number().integer().min(1).max(10000),
  ipWhitelist: Joi.array().items(Joi.string().trim().max(64).regex(IP_PATTERN)).max(200),
  remark: Joi.string().trim().max(255).allow('', null),
};

const listDataApis = {
  query: Joi.object()
    .keys({
      keyword: Joi.string().trim().max(64).allow(''),
      status: Joi.string().valid(...STATUSES),
      method: Joi.string().valid(...METHODS),
      datasourceId: Joi.string().trim().max(64),
      sort: Joi.string().trim().pattern(/^[A-Za-z._]+(:asc|:desc)?$/i),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

const getDataApi = {
  params: Joi.object().keys({ id }),
};

const createDataApi = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      path: baseKeys.path.required(),
      datasourceId: baseKeys.datasourceId.required(),
      tableName: baseKeys.tableName.required(),
      fields: baseKeys.fields.required().min(1),
    })
    .required(),
};

const updateDataApi = {
  params: Joi.object().keys({ id }),
  body: Joi.object().keys(baseKeys).min(1),
};

const deleteDataApi = {
  params: Joi.object().keys({ id }),
};

/** publish / unpublish 只需要 id */
const publishDataApi = {
  params: Joi.object().keys({ id }),
  body: Joi.object().unknown(true),
};

const getDataApiStats = {
  params: Joi.object().keys({ id }),
};

/**
 * POST /data-apis/:id/invoke —— 前端「调试」按钮代理：
 * body 里可以直接给 query 对象（前端表单用的字段名是 queryParams，控制器里两者等价），
 * 也可以把 page/size/limit 平铺在根上（controller 会合并）。
 */
const invokeDataApi = {
  params: Joi.object().keys({ id }),
  body: Joi.object()
    .keys({
      query: Joi.object().unknown(true),
      queryParams: Joi.object().unknown(true),
      apiKey: Joi.string().trim().max(128).allow('', null),
      page: Joi.number().integer().min(1),
      size: Joi.number().integer().min(1).max(500),
      limit: Joi.number().integer().min(1).max(500),
    })
    .unknown(true),
};

module.exports = {
  METHODS,
  STATUSES,
  QUERY_TYPES,
  listDataApis,
  getDataApi,
  createDataApi,
  updateDataApi,
  deleteDataApi,
  publishDataApi,
  invokeDataApi,
  getDataApiStats,
};
