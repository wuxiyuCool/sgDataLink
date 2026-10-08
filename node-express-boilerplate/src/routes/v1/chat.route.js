const express = require('express');
const validate = require('../../middlewares/validate');
const metricChatValidation = require('../../validations/metricchat.validation');
const chatRuntimeController = require('../../controllers/chatruntime.controller');

/**
 * 问数对外运行时路由（契约 1.12 增补，仿 /ds 免 JWT 模式）：
 * 鉴权在 controller 内做 chatKey 校验（X-CHAT-KEY 头或 chatKey 查询参数）。
 */
const router = express.Router();

router.post('/ask', validate(metricChatValidation.ask), chatRuntimeController.ask);

module.exports = router;
