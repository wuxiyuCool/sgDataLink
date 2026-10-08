const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricDomainValidation = require('../../validations/metricdomain.validation');
const metricDomainController = require('../../controllers/metricdomain.controller');

/**
 * 指标域路由（docs/API.md 1.12）：整组 JWT；删除保护/编码终身制在 service。
 */
const router = express.Router();

router.use(auth());

router.get('/tree', validate(metricDomainValidation.getTree), metricDomainController.getTree);

router
  .route('/')
  .get(validate(metricDomainValidation.listDomains), metricDomainController.listDomains)
  .post(validate(metricDomainValidation.createDomain), metricDomainController.createDomain);

router
  .route('/:id')
  .put(validate(metricDomainValidation.updateDomain), metricDomainController.updateDomain)
  .delete(validate(metricDomainValidation.deleteDomain), metricDomainController.deleteDomain);

module.exports = router;
