const Joi = require('joi');

/**
 * 数据服务（Data API）管理端校验（docs/API.md 第 1.9 节）。
 * 运行时端点 /ds/{path} 不在这套 schema 里（query 参数按定义动态变化，
 * 由 services/dataApiRuntime.service.js 自己解析 page/size/limit）。
 */

const STATUSES = ['draft', 'published'];
const METHODS = ['GET', 'POST'];
/**
 * 声明的查询参数支持的类型。
 * string/number/date/list 是契约 1.9.2 的四种（list 值逗号分隔或重复参数，元素上限 1000）；
 * boolean 只有 builder 模式用得上（等值过滤），custom 模式在 service 里再收口到前四种。
 */
const QUERY_TYPES = ['string', 'number', 'date', 'list', 'boolean'];
/** 1.9.2 SQL 构建模式 */
const SQL_MODES = ['builder', 'custom'];
/** customSql 长度上限（与 sqlGuard.MAX_SQL_LENGTH 同值） */
const MAX_SQL_LENGTH = 20000;
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

/**
 * 参数名要和 sqlGuard 的 `:name` 占位符解析对齐：字母/下划线开头 + 只允许字母数字下划线，
 * 且不能含 list 展开用的 `__` 分隔符，也不能占用分页包装的 dbr_ 前缀绑定名。
 */
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const queryParam = Joi.object().keys({
  name: Joi.string()
    .trim()
    .min(1)
    .max(64)
    .pattern(PARAM_NAME_PATTERN)
    .custom((value, helpers) =>
      value.includes('__') || /^dbr_/i.test(value) ? helpers.error('any.invalid') : value
    )
    .required(),
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
  /** 1.9.2 builder（按 tableName+fields 拼 SELECT）| custom（执行 customSql） */
  sqlMode: Joi.string().valid(...SQL_MODES),
  customSql: Joi.string()
    .trim()
    .max(MAX_SQL_LENGTH)
    .allow('', null),
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

/**
 * 创建：name/path/datasourceId 恒必填；
 * tableName/fields 只在 builder 模式必填（custom 模式由 customSql 决定输出列），
 * 两者的必填判定统一放在 services/dataApi.service.js 的 assertDefinition 里（能给出 40001 的中文原因）。
 */
const createDataApi = {
  body: Joi.object()
    .keys({
      ...baseKeys,
      name: baseKeys.name.required(),
      path: baseKeys.path.required(),
      datasourceId: baseKeys.datasourceId.required(),
      tableName: baseKeys.tableName.when('sqlMode', { is: 'builder', then: baseKeys.tableName.required() }),
      fields: baseKeys.fields.when('sqlMode', { is: 'builder', then: baseKeys.fields.required().min(1) }),
      customSql: baseKeys.customSql.when('sqlMode', { is: 'custom', then: baseKeys.customSql.required() }),
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

/**
 * 1.9.1 元数据浏览：GET /data-apis/meta/tables 与 /data-apis/meta/columns。
 * tableName 走标识符白名单（sqlGuard/dataQuery 侧还会再校验一次），只接受单段或 schema.table。
 */
const listMetaTables = {
  query: Joi.object()
    .keys({
      datasourceId: Joi.string().trim().max(64).required(),
      keyword: Joi.string().trim().max(128).allow(''),
    })
    .unknown(true),
};

const listMetaColumns = {
  query: Joi.object()
    .keys({
      datasourceId: Joi.string().trim().max(64).required(),
      tableName: Joi.string()
        .trim()
        .max(128)
        .pattern(/^[A-Za-z_][A-Za-z0-9_$]{0,63}(\.[A-Za-z_][A-Za-z0-9_$]{0,63})?$/)
        .required(),
    })
    .unknown(true),
};

module.exports = {
  METHODS,
  STATUSES,
  QUERY_TYPES,
  SQL_MODES,
  listDataApis,
  getDataApi,
  createDataApi,
  updateDataApi,
  deleteDataApi,
  publishDataApi,
  invokeDataApi,
  getDataApiStats,
  listMetaTables,
  listMetaColumns,
};
