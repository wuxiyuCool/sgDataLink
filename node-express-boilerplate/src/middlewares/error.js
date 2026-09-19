const mongoose = require('mongoose');
const httpStatus = require('http-status');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const { BIZ_CODE_BY_HTTP_STATUS } = require('../config/errorCodes');

const errorConverter = (err, req, res, next) => {
  let error = err;
  if (!(error instanceof ApiError)) {
    const statusCode =
      error.statusCode || error instanceof mongoose.Error ? httpStatus.BAD_REQUEST : httpStatus.INTERNAL_SERVER_ERROR;
    const message = error.message || httpStatus[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
    // 保留业务码（DataBridge 契约），非 ApiError 抛出的场景也能带出 400xx/500xx
    if (err.bizCode) error.bizCode = err.bizCode;
  }
  next(error);
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  if (config.env === 'production' && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  res.locals.errorMessage = err.message;

  // DataBridge 契约：错误响应同样是统一信封，code 为业务码（未显式标注时按 HTTP 状态推导）
  const response = {
    code: err.bizCode || BIZ_CODE_BY_HTTP_STATUS[statusCode] || statusCode,
    message,
    result: null,
    timestamp: Date.now(),
    ...(config.env === 'development' && { stack: err.stack }),
  };

  if (config.env === 'development') {
    logger.error(err);
  }

  res.status(statusCode).send(response);
};

module.exports = {
  errorConverter,
  errorHandler,
};
