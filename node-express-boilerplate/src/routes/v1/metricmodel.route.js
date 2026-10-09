const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricModelValidation = require('../../validations/metricmodel.validation');
const metricModelController = require('../../controllers/metricmodel.controller');

/**
 * 数据模型路由（docs/API.md 1.12）：整组 JWT。
 */
const router = express.Router();

router.use(auth());

router.get('/column-types', metricModelController.columnTypes);

router.post('/preview-ddl', validate(metricModelValidation.previewDdl), metricModelController.previewDdl);

router
  .route('/')
  .get(validate(metricModelValidation.listModels), metricModelController.getModels)
  .post(validate(metricModelValidation.createModel), metricModelController.createModel);

router
  .route('/:id')
  .get(validate(metricModelValidation.getModel), metricModelController.getModel)
  .put(validate(metricModelValidation.updateModel), metricModelController.updateModel)
  .delete(validate(metricModelValidation.deleteModel), metricModelController.deleteModel);

router.post('/:id/create-table', validate(metricModelValidation.createTable), metricModelController.createTable);

// 维度取值档案与码值登记（契约 1.14）
router.post(
  '/:id/profile-dimensions',
  validate(metricModelValidation.profileDimensions),
  metricModelController.profileDimensions
);
router
  .route('/:id/dimension-values')
  .get(validate(metricModelValidation.getDimensionValues), metricModelController.getDimensionValues)
  .put(validate(metricModelValidation.saveDimensionValues), metricModelController.saveDimensionValues)
  .delete(validate(metricModelValidation.clearDimensionValues), metricModelController.clearDimensionValues);

router.get('/:id/preview', validate(metricModelValidation.getModel), metricModelController.previewModel);

router.put('/:id/columns', validate(metricModelValidation.replaceColumns), metricModelController.updateColumns);

module.exports = router;
