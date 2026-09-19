const express = require('express');
const validate = require('../../middlewares/validate');
const dataflowValidation = require('../../validations/dataflow.validation');
const dataflowController = require('../../controllers/dataflow.controller');

/**
 * 数据开发（ETL 画布）路由（docs/API.md 第 1.8 节）。
 *
 * TODO 第二阶段挂鉴权：router.use(auth('manageDataflows'))
 * Mock 阶段不鉴权，前端画布直接调用。
 */
const router = express.Router();

router
  .route('/')
  .get(validate(dataflowValidation.listDataflows), dataflowController.getDataflows)
  .post(validate(dataflowValidation.createDataflow), dataflowController.createDataflow);

router.post('/:id/run', validate(dataflowValidation.runDataflow), dataflowController.runDataflow);
router.post('/:id/stop', validate(dataflowValidation.stopDataflow), dataflowController.stopDataflow);
router.get('/:id/progress', validate(dataflowValidation.getDataflowProgress), dataflowController.getDataflowProgress);

router
  .route('/:id')
  .get(validate(dataflowValidation.getDataflow), dataflowController.getDataflow)
  .put(validate(dataflowValidation.updateDataflow), dataflowController.updateDataflow)
  .delete(validate(dataflowValidation.deleteDataflow), dataflowController.deleteDataflow);

module.exports = router;
