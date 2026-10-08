const httpStatus = require('http-status');
const config = require('../config/config');
const logger = require('../config/logger');
const { bizError } = require('../utils/bizError');

/**
 * 引擎回报通道鉴权（契约 1.12「引擎共享密钥」，配合 docs/API.md 1.4）。
 * ENGINE_SHARED_SECRET 配置后：/engine/report、/engine/logs 必须带匹配的 X-Engine-Token，
 * 不匹配 -> HTTP 401 + 业务码 40101（与引擎侧入站规则对称）。
 * 未配置：放行并打一条 WARN（平滑过渡态，生产禁止长期为空）。
 */
let warned = false;

const engineToken = (req, res, next) => {
  const secret = config.engine.sharedSecret;
  if (!secret) {
    if (!warned) {
      warned = true;
      logger.warn('ENGINE_SHARED_SECRET 未配置：/engine 回报通道处于无鉴权过渡态');
    }
    return next();
  }
  if (req.get('x-engine-token') !== secret) {
    return next(bizError(40101, 'X-Engine-Token 缺失或不匹配', httpStatus.UNAUTHORIZED));
  }
  return next();
};

module.exports = engineToken;
