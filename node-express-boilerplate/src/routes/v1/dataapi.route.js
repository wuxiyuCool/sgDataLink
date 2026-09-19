const express = require('express');
const validate = require('../../middlewares/validate');
const dataApiValidation = require('../../validations/dataapi.validation');
const dataApiController = require('../../controllers/dataapi.controller');

/**
 * 数据服务（Data API）管理端路由（docs/API.md 第 1.9 节）。
 *
 * 对外运行时端点 /ds/{path} 不在这里，它挂在 app.js 顶层（src/routes/ds.route.js）。
 * TODO 第二阶段挂鉴权：router.use(auth('manageDataApis'))
 */
const router = express.Router();

router
  .route('/')
  .get(validate(dataApiValidation.listDataApis), dataApiController.getDataApis)
  .post(validate(dataApiValidation.createDataApi), dataApiController.createDataApi);

router.post('/:id/publish', validate(dataApiValidation.publishDataApi), dataApiController.publishDataApi);
router.post('/:id/unpublish', validate(dataApiValidation.publishDataApi), dataApiController.unpublishDataApi);
router.post('/:id/invoke', validate(dataApiValidation.invokeDataApi), dataApiController.invokeDataApi);
router.get('/:id/stats', validate(dataApiValidation.getDataApiStats), dataApiController.getDataApiStats);

router
  .route('/:id')
  .get(validate(dataApiValidation.getDataApi), dataApiController.getDataApi)
  .put(validate(dataApiValidation.updateDataApi), dataApiController.updateDataApi)
  .delete(validate(dataApiValidation.deleteDataApi), dataApiController.deleteDataApi);

module.exports = router;
