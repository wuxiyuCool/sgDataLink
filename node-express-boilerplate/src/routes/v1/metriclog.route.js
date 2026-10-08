const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricChatValidation = require('../../validations/metricchat.validation');
const metricChatController = require('../../controllers/metricchat.controller');

/**
 * 问数审计日志路由（docs/API.md 1.12 §7.4）：/metric-logs。
 * 列表 JWT；转示例仅 admin（manageMetrics）——错误示例污染 few-shot 的防线。
 */
const router = express.Router();

router.get('/', auth(), validate(metricChatValidation.listLogs), metricChatController.getLogs);

router.post(
  '/:id/to-example',
  auth('manageMetrics'),
  validate(metricChatValidation.logToExample),
  metricChatController.logToExample
);

module.exports = router;
