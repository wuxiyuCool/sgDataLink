const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricChatValidation = require('../../validations/metricchat.validation');
const metricChatController = require('../../controllers/metricchat.controller');

/**
 * 示例问答路由（docs/API.md 1.12 §7.4）：/metric-examples，few-shot 素材。整组 JWT。
 */
const router = express.Router();

router.use(auth());

router
  .route('/')
  .get(validate(metricChatValidation.listExamples), metricChatController.getExamples)
  .post(validate(metricChatValidation.exampleBody), metricChatController.createExample);

router
  .route('/:id')
  .put(validate(metricChatValidation.exampleUpdate), metricChatController.updateExample)
  .delete(validate(metricChatValidation.exampleParam), metricChatController.deleteExample);

module.exports = router;
