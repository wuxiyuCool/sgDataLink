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

router.get('/:id/preview', validate(metricModelValidation.getModel), metricModelController.previewModel);

router.put('/:id/columns', validate(metricModelValidation.replaceColumns), metricModelController.updateColumns);

module.exports = router;
