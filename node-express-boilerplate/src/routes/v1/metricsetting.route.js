const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricSettingValidation = require('../../validations/metricsetting.validation');
const metricSettingController = require('../../controllers/metricsetting.controller');

/**
 * 指标中心系统配置路由（docs/API.md 1.12）：仅 admin（manageMetrics）。
 */
const router = express.Router();

router.use(auth('manageMetrics'));

router
  .route('/')
  .get(validate(metricSettingValidation.getSettings), metricSettingController.getSettings)
  .put(validate(metricSettingValidation.updateSettings), metricSettingController.updateSettings);

module.exports = router;
