const express = require('express');
const validate = require('../../middlewares/validate');
const authValidation = require('../../validations/auth.validation');
const authController = require('../../controllers/auth.controller');
const auth = require('../../middlewares/auth');
const { authLimiter } = require('../../middlewares/rateLimiter');

/**
 * 鉴权路由（docs/API.md 1.11）。
 * login 挂 authLimiter（15 分钟窗口 20 次失败限流，防爆破）；
 * me / change-password 需要 JWT；身份只从 token 取，路由不吃任何 userId 参数（无 IDOR 面）。
 */
const router = express.Router();

router.post('/login', authLimiter, validate(authValidation.login), authController.login);
router.get('/me', auth(), authController.me);
router.post('/change-password', auth(), validate(authValidation.changePassword), authController.changePassword);
// 登录日志审计：仅 admin（契约 1.11），身份只从 token 取
router.get('/login-logs', auth('manageUsers'), authController.loginLogs);
// 1.9.5 docKey：本人查看/刷新（权限位由 admin 在 /users 开通）
router.get('/doc-key', auth(), authController.getDocKey);
router.post('/doc-key/refresh', auth(), authController.refreshDocKey);

// 问数对外服务（契约 1.12 增补）：本人查看/刷新 chatKey
router.get('/chat-key', auth(), authController.getChatKey);
router.post('/chat-key/refresh', auth(), authController.refreshChatKey);

module.exports = router;
