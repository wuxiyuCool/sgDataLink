const express = require('express');
const validate = require('../../middlewares/validate');
const datasourceValidation = require('../../validations/datasource.validation');
const datasourceController = require('../../controllers/datasource.controller');

/**
 * 数据源路由（docs/API.md 第 1.1 节）。
 *
 * TODO 第二阶段挂鉴权：
 *   router.use(auth('manageDatasources'))  // 见 middlewares/auth.js + config/roles.js
 * Mock 阶段前端不登录，故这里不加 auth，脚手架自带 /auth /users 路由仍走原鉴权。
 */
const router = express.Router();

// 注意：/test 必须在 /:id 之前注册，否则 'test' 会被当成 :id
router.post('/test', validate(datasourceValidation.testDataSource), datasourceController.testDataSource);

router
  .route('/')
  .get(validate(datasourceValidation.listDataSources), datasourceController.getDataSources)
  .post(validate(datasourceValidation.createDataSource), datasourceController.createDataSource);

router
  .route('/:id')
  .get(validate(datasourceValidation.getDataSource), datasourceController.getDataSource)
  .put(validate(datasourceValidation.updateDataSource), datasourceController.updateDataSource)
  .delete(validate(datasourceValidation.deleteDataSource), datasourceController.deleteDataSource);

router.post('/:id/test', validate(datasourceValidation.testDataSourceById), datasourceController.testDataSourceById);

module.exports = router;
