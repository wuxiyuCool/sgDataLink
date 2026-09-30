const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
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

/**
 * 1.9.1 元数据浏览：**必须注册在 /:id 之前**，否则 'meta' 会被当成 :id 吃掉（→ 40401）。
 */
router.get('/meta/tables', validate(dataApiValidation.listMetaTables), dataApiController.listMetaTables);
router.get('/meta/columns', validate(dataApiValidation.listMetaColumns), dataApiController.listMetaColumns);

/**
 * 1.9 调用明细日志：同样**必须在 /:id 之前**，不然 'calls' 会被当成 id 查不到（→ 40401）。
 */
router.get('/calls', validate(dataApiValidation.listDataApiCalls), dataApiController.listDataApiCalls);

/**
 * 1.9.4 Swagger 文档中心：**必须注册在 /:id 之前**（'swagger.json' 会被当成 :id）。
 * 查看需登录（契约：JWT，401 未登录不可见）；status=all 的 admin 判定在控制器。
 */
router.get('/swagger.json', auth(), validate(dataApiValidation.getSwagger), dataApiController.getSwagger);

/** 1.9.4 文档配置：读需登录（模板兜底在 service），保存仅 admin */
router.get('/:id/doc', auth(), validate(dataApiValidation.getDataApiDoc), dataApiController.getDataApiDoc);
router.put('/:id/doc', auth('manageUsers'), validate(dataApiValidation.updateDataApiDoc), dataApiController.updateDataApiDoc);

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
