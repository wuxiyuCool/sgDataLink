const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricChatValidation = require('../../validations/metricchat.validation');
const metricChatController = require('../../controllers/metricchat.controller');

/**
 * 业务术语路由（docs/API.md 1.12 §7.4）：/metric-terms。整组 JWT。
 */
const router = express.Router();

router.use(auth());

router
  .route('/')
  .get(validate(metricChatValidation.listTerms), metricChatController.getTerms)
  .post(validate(metricChatValidation.termBody), metricChatController.createTerm);

router
  .route('/:id')
  .put(validate(metricChatValidation.termUpdate), metricChatController.updateTerm)
  .delete(validate(metricChatValidation.termParam), metricChatController.deleteTerm);

module.exports = router;
