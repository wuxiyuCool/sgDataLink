const express = require('express');
const validate = require('../../middlewares/validate');
const auth = require('../../middlewares/auth');
const metricModelCategoryValidation = require('../../validations/metricmodelcategory.validation');
const metricModelCategoryController = require('../../controllers/metricmodelcategory.controller');

/**
 * 建模分层树「分类」路由（docs/API.md 1.16）：整组 JWT。
 * 注意顺序：/tree 与 /assign 必须排在 /:id 之前，否则会被当成分类 id 误匹配。
 */
const router = express.Router();

router.use(auth());

router.get('/tree', validate(metricModelCategoryValidation.getTree), metricModelCategoryController.getTree);

router.post('/assign', validate(metricModelCategoryValidation.assignCategories), metricModelCategoryController.assign);

router.post('/', validate(metricModelCategoryValidation.createCategory), metricModelCategoryController.createCategory);

router
  .route('/:id')
  .put(validate(metricModelCategoryValidation.updateCategory), metricModelCategoryController.updateCategory)
  .delete(validate(metricModelCategoryValidation.deleteCategory), metricModelCategoryController.deleteCategory);

module.exports = router;
