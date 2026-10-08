const express = require('express');
const validate = require('../../middlewares/validate');
const engineToken = require('../../middlewares/engineToken');
const engineValidation = require('../../validations/engine.validation');
const engineController = require('../../controllers/engine.controller');

/**
 * Go 同步引擎回调路由（docs/API.md 第 1.4 节）。
 * 契约 1.12：共享密钥鉴权（ENGINE_SHARED_SECRET 非空时强制 X-Engine-Token；空 = 过渡态放行 + WARN）。
 */
const router = express.Router();

router.use(engineToken);

router.post('/report', validate(engineValidation.report), engineController.report);
router.post('/logs', validate(engineValidation.logs), engineController.logs);

module.exports = router;
