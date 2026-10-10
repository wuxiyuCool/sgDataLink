const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { metricModelCategoryService } = require('../services');

/**
 * 建模分层树「分类」HTTP 层（docs/API.md 1.16）。
 * 树 = 5 个固定分层根（虚拟化）→ 分类节点；分类操作只动元数据，零 DDL。
 */

/** GET /metric-model-categories/tree */
const getTree = catchAsync(async (req, res) => {
  ok(res, await metricModelCategoryService.getTree());
});

const createCategory = catchAsync(async (req, res) => {
  const result = await metricModelCategoryService.createCategory(req.body, req.user && req.user.username);
  ok(res, result, { message: '创建成功' });
});

const updateCategory = catchAsync(async (req, res) => {
  ok(res, await metricModelCategoryService.updateCategory(req.params.id, req.body), { message: '更新成功' });
});

/** DELETE：软删 + 名下模型自动降级未分类，movedModels 供界面二次确认文案报数 */
const deleteCategory = catchAsync(async (req, res) => {
  ok(res, await metricModelCategoryService.deleteCategory(req.params.id), { message: '删除成功' });
});

/** POST /assign：跨层逐条点名，HTTP 恒 200（与 /metrics/batch 同形） */
const assign = catchAsync(async (req, res) => {
  const result = await metricModelCategoryService.assign(req.body);
  ok(res, result, { message: `归类 ${result.assigned} 个，失败 ${result.failed} 个` });
});

module.exports = { getTree, createCategory, updateCategory, deleteCategory, assign };
