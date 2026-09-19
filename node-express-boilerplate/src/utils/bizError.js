const httpStatus = require('http-status');
const ApiError = require('./ApiError');
const { ERROR_CODES, HTTP_STATUS_BY_CODE } = require('../config/errorCodes');

/**
 * 构造带业务码的 ApiError。
 *
 * 脚手架原有错误链路（middlewares/error.js）只看 statusCode；
 * 这里额外挂上 bizCode，errorHandler 会用 bizCode 作为响应体的 code 字段，
 * 从而在保持分层风格的同时满足 DataBridge 契约的统一响应信封。
 *
 * @param {number} code 业务错误码，见 config/errorCodes.js
 * @param {string} message 面向前端的错误信息
 * @param {number} [statusCode] HTTP 状态码，缺省按业务码推导
 */
const bizError = (code, message, statusCode) => {
  const status = statusCode || HTTP_STATUS_BY_CODE[code] || httpStatus.INTERNAL_SERVER_ERROR;
  const error = new ApiError(status, message);
  error.bizCode = code;
  return error;
};

/** 40001 参数/状态校验失败，message 只写「缺了什么」，前缀由这里补齐 */
const paramInvalid = (message) => bizError(ERROR_CODES.PARAM_INVALID, `参数校验失败: ${message}`);

/** 40401 资源不存在 */
const notFound = (message) => bizError(ERROR_CODES.NOT_FOUND, message);

/** 40002 数据源被任务引用，禁止删除 */
const datasourceReferenced = (message) => bizError(ERROR_CODES.DATASOURCE_REFERENCED, message);

/** 40003 任务 running 中，禁止编辑 / 删除 */
const runningForbidden = (message) => bizError(ERROR_CODES.RUNNING_FORBIDDEN, message);

/** 40901 重复启动 */
const duplicateStart = (message) => bizError(ERROR_CODES.DUPLICATE_START, message);

/** 50001 引擎不可达 / 超时 */
const engineUnavailable = (message) => bizError(ERROR_CODES.ENGINE_UNAVAILABLE, message);

/** 50002 引擎返回业务失败 */
const engineRejected = (message) => bizError(ERROR_CODES.ENGINE_REJECTED, message);

/** 40101 调用数据服务未携带 API Key（docs/API.md 1.9 运行时网关） */
const apiKeyMissing = (message) => bizError(ERROR_CODES.API_KEY_MISSING, message);

/** 40102 API Key 不匹配 */
const apiKeyInvalid = (message) => bizError(ERROR_CODES.API_KEY_INVALID, message);

/** 40301 客户端 IP 不在白名单 */
const ipNotWhitelisted = (message) => bizError(ERROR_CODES.IP_NOT_WHITELISTED, message);

/** 42901 超过限流 QPS */
const rateLimitExceeded = (message) => bizError(ERROR_CODES.RATE_LIMIT_EXCEEDED, message);

/** 40404 数据服务路径不存在或未发布 */
const dataApiNotFound = (message) => bizError(ERROR_CODES.DATA_API_NOT_FOUND, message);

module.exports = {
  ERROR_CODES,
  bizError,
  paramInvalid,
  notFound,
  datasourceReferenced,
  runningForbidden,
  duplicateStart,
  engineUnavailable,
  engineRejected,
  apiKeyMissing,
  apiKeyInvalid,
  ipNotWhitelisted,
  rateLimitExceeded,
  dataApiNotFound,
};
