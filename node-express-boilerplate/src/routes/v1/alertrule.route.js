const express = require('express');
const validate = require('../../middlewares/validate');
const alertRuleValidation = require('../../validations/alertrule.validation');
const alertRuleController = require('../../controllers/alertrule.controller');

/**
 * 告警规则路由（docs/API.md 第 1.10 节）。
 * TODO 第二阶段挂鉴权：router.use(auth('manageAlerts'))
 */
const router = express.Router();

router
  .route('/')
  .get(validate(alertRuleValidation.listAlertRules), alertRuleController.getAlertRules)
  .post(validate(alertRuleValidation.createAlertRule), alertRuleController.createAlertRule);

router
  .route('/:id')
  .get(validate(alertRuleValidation.getAlertRule), alertRuleController.getAlertRule)
  .put(validate(alertRuleValidation.updateAlertRule), alertRuleController.updateAlertRule)
  .delete(validate(alertRuleValidation.deleteAlertRule), alertRuleController.deleteAlertRule);

module.exports = router;
