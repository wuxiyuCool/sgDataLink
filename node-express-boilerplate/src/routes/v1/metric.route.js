const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricValidation = require('../../validations/metric.validation');
const metricController = require('../../controllers/metric.controller');

/**
 * 指标管理路由（docs/API.md 1.12 §6）：整组 JWT。
 */
const router = express.Router();

router.use(auth());

router.post('/validate', validate(metricValidation.validateDraft), metricController.validateDraft);

router
  .route('/')
  .get(validate(metricValidation.listMetrics), metricController.getMetrics)
  .post(validate(metricValidation.createMetric), metricController.createMetric);

router
  .route('/:id')
  .get(validate(metricValidation.getMetric), metricController.getMetric)
  .put(validate(metricValidation.updateMetric), metricController.updateMetric)
  .delete(validate(metricValidation.deleteMetric), metricController.deleteMetric);

router.get('/:id/tree', validate(metricValidation.getTree), metricController.getTree);
router.get('/:id/lineage', validate(metricValidation.getLineage), metricController.getLineage);
router.post('/:id/preview', validate(metricValidation.preview), metricController.preview);
router.get('/:id/versions', validate(metricValidation.listVersions), metricController.listVersions);
router.post('/:id/rollback', validate(metricValidation.rollback), metricController.rollback);

module.exports = router;
