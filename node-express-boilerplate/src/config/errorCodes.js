/**
 * 业务错误码（docs/API.md 第 0 节）
 *
 * code 非 0 即为业务错误码：400xx 参数/状态错误，404xx 资源不存在，500xx 服务异常。
 * statusCode 为同时返回的 HTTP 状态码（契约要求「HTTP 状态码同步返回 4xx/5xx」）。
 */
const ERROR_CODES = {
  PARAM_INVALID: 40001,
  DATASOURCE_REFERENCED: 40002,
  RUNNING_FORBIDDEN: 40003,
  NOT_FOUND: 40401,
  DUPLICATE_START: 40901,
  // 数据服务运行时网关（docs/API.md 1.9）：/ds 对外的四类拒绝，HTTP 状态码即契约指定值
  API_KEY_MISSING: 40101,
  API_KEY_INVALID: 40102,
  IP_NOT_WHITELISTED: 40301,
  RATE_LIMIT_EXCEEDED: 42901,
  DATA_API_NOT_FOUND: 40404,
  ENGINE_UNAVAILABLE: 50001,
  ENGINE_REJECTED: 50002,
  /** Data API 真实查询失败（目标库连接/SQL 报错），docs/API.md 1.9 */
  DATA_QUERY_FAILED: 50003,
  INTERNAL_ERROR: 50000,
};

const HTTP_STATUS_BY_CODE = {
  40001: 400,
  // 被引用无法删除 / running 中无法编辑：都是资源状态冲突，HTTP 返回 409
  40002: 409,
  40003: 409,
  40401: 404,
  40901: 409,
  40101: 401,
  40102: 401,
  40301: 403,
  42901: 429,
  40404: 404,
  50000: 500,
  50001: 502,
  50002: 502,
  50003: 502,
};

/**
 * 未显式标注业务码时的兜底推导（脚手架自带路由抛出的 ApiError 走这里，
 * 保证任何错误响应都符合契约的统一信封）。
 */
const BIZ_CODE_BY_HTTP_STATUS = {
  400: 40001,
  404: 40401,
  409: 40901,
  500: 50000,
};

module.exports = {
  ERROR_CODES,
  HTTP_STATUS_BY_CODE,
  BIZ_CODE_BY_HTTP_STATUS,
};
