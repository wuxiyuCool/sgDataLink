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

module.exports = router;
