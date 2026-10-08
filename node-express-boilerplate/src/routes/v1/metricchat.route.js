const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricChatValidation = require('../../validations/metricchat.validation');
const metricChatController = require('../../controllers/metricchat.controller');

/**
 * 智能问数路由（docs/API.md 1.12 §7.4）：/metric-chat。整组 JWT。
 */
const router = express.Router();

router.use(auth());

router.post('/ask', validate(metricChatValidation.ask), metricChatController.ask);

router.get('/sessions/:id/history', validate(metricChatValidation.sessionParam), metricChatController.getSession);
router.post('/sessions/:id/history', validate(metricChatValidation.sessionParam), metricChatController.clearSession);

module.exports = router;
