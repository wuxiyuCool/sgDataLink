const express = require('express');
const validate = require('../../middlewares/validate');
const engineValidation = require('../../validations/engine.validation');
const engineController = require('../../controllers/engine.controller');

/**
 * Go 同步引擎回调路由（docs/API.md 第 1.4 节）。
 *
 * 契约明确：/engine 回调仅供引擎调用，Mock 阶段不鉴权。
 * TODO 第二阶段：改为内网来源校验 / 共享 token（如 X-Engine-Token），仍不使用用户 JWT。
 */
const router = express.Router();

router.post('/report', validate(engineValidation.report), engineController.report);
router.post('/logs', validate(engineValidation.logs), engineController.logs);

module.exports = router;
