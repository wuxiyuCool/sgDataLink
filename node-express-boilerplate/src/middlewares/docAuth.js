/**
 * 文档中心双通道认证（契约 1.9.5）：swagger.json 支持 JWT（原链路）或 docKey 免登录。
 *
 * 认证失败也要留审计（成败都写 databridge_doc_access_log）；
 * docKey 只记掩码，key 原文/JWT 绝不落库、不回显。
 */
const httpStatus = require('http-status');
const auth = require('./auth');
const ApiError = require('../utils/ApiError');
const { accountService } = require('../services');

/** 与 controllers/auth.controller.js 的 clientIp 同口径（xff 首段 → x-real-ip → req.ip） */
const clientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim();
  return first || req.headers['x-real-ip'] || req.ip || '';
};

const baseOf = (req) => ({
  ip: clientIp(req),
  keyword: String(req.query.keyword || '').slice(0, 64) || null,
  userAgent: String(req.headers['user-agent'] || '').slice(0, 255) || null,
});

/** 失败留痕（认证层能拿到的信息尽量记，拿不到的置 null） */
const logFailure = async (req, extra, err) => {
  await accountService.recordDocAccess({
    ...baseOf(req),
    ok: false,
    httpStatus: (err && err.statusCode) || httpStatus.UNAUTHORIZED,
    bizCode: (err && err.bizCode) || null,
    errorMsg: err ? String(err.message || err).slice(0, 255) : null,
    ...extra,
  });
};

/**
 * 路由级守卫：Authorization: Bearer 存在 → 走原 JWT 链（auth()）；
 * 否则取 X-DOC-KEY 头 / docKey 查询参数走 docKey 通道（accountService.resolveDocKey）。
 * 通过后在 req.docAuth 上挂 { type, user, keyMasked }，控制器据此决定 status 上限与日志归属。
 */
const swaggerAuth = (req, res, next) => {
  const bearer = String(req.headers.authorization || '');
  if (bearer.startsWith('Bearer ')) {
    auth()(req, res, (err) => {
      if (err) {
        logFailure(req, { authType: 'jwt' }, err).then(() => next(err), () => next(err));
        return;
      }
      req.docAuth = { type: 'jwt', user: req.user };
      next();
    });
    return;
  }
  const rawKey = req.get('x-doc-key') || req.query.docKey || '';
  accountService
    .resolveDocKey(rawKey)
    .then(({ user, keyMasked }) => {
      req.docAuth = { type: 'docKey', user, keyMasked };
      next();
    })
    .catch(async (err) => {
      await logFailure(req, { authType: 'docKey', keyMasked: accountService.maskDocKey(rawKey) }, err);
      next(err);
    });
};

module.exports = {
  swaggerAuth,
  clientIp,
  baseOf,
  logFailure,
};
