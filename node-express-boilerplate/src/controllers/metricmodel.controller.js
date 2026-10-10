const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const config = require('../config/config');
const { ok, pageResult } = require('../utils/apiResponse');
const { metricModelService, metricExecService, metricDimService } = require('../services');

/**
 * 数据模型 HTTP 层（docs/API.md 1.12）。
 */

const getModels = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['domainId', 'layer', 'datasourceId', 'status', 'categoryId']);
  const options = pick(req.query, ['keyword', 'page', 'size', 'sort']);
  pageResult(res, await metricModelService.queryModels(filter, options));
});

const getModel = catchAsync(async (req, res) => {
  ok(res, await metricModelService.getModel(req.params.id));
});

const createModel = catchAsync(async (req, res) => {
  const result = await metricModelService.createModel(req.body, req.user && req.user.username);
  ok(res, result, { message: '创建成功' });
});

const updateModel = catchAsync(async (req, res) => {
  ok(res, await metricModelService.updateModel(req.params.id, req.body), { message: '更新成功' });
});

const updateColumns = catchAsync(async (req, res) => {
  ok(res, await metricModelService.replaceColumns(req.params.id, req.body.columns), { message: '字段已保存' });
});

const deleteModel = catchAsync(async (req, res) => {
  ok(res, await metricModelService.deleteModel(req.params.id, req.query), { message: '删除成功' });
});

/** GET /metric-models/column-types —— 字段类型目录（按方言给真实类型名与长度上限，界面下拉唯一来源） */
const columnTypes = catchAsync(async (req, res) => {
  ok(res, metricModelService.columnTypes());
});

/** POST /metric-models/:id/create-table —— 在目标库真建物理表（契约 1.13，仅界面建表模型 + 已启用） */
const createTable = catchAsync(async (req, res) => {
  ok(res, await metricModelService.createTableModel(req.params.id));
});

/** POST /metric-models/:id/profile-dimensions —— 探查维度取值（契约 1.14，真查目标库） */
const profileDimensions = catchAsync(async (req, res) => {
  const model = await metricModelService.getModel(req.params.id);
  ok(res, await metricDimService.profileModel(model, req.body));
});

/** GET /metric-models/:id/dimension-values —— 读档案（不打源库） */
const getDimensionValues = catchAsync(async (req, res) => {
  const model = await metricModelService.getModel(req.params.id);
  ok(res, await metricDimService.listValues(model, pick(req.query, ['columnName', 'keyword'])));
});

/** PUT /metric-models/:id/dimension-values —— 登记码值业务名（01=华东） */
const saveDimensionValues = catchAsync(async (req, res) => {
  const model = await metricModelService.getModel(req.params.id);
  ok(res, await metricDimService.saveLabels(model, req.body), { message: '取值已登记' });
});

/** DELETE /metric-models/:id/dimension-values?columnName= —— 清该列档案 */
const clearDimensionValues = catchAsync(async (req, res) => {
  const model = await metricModelService.getModel(req.params.id);
  ok(res, await metricDimService.clearColumn(model, req.query.columnName), { message: '已清空该列取值档案' });
});

const previewDdl = catchAsync(async (req, res) => {
  ok(res, await metricModelService.previewDdl(req.body));
});

/** GET /metric-models/:id/preview —— 前 N 行真实数据（memory 驱动返回 executable:false） */
const previewModel = catchAsync(async (req, res) => {
  const model = await metricModelService.getModel(req.params.id);
  if (config.db.driver !== 'mysql') {
    ok(res, { executable: false, columns: null, rows: null, note: '内存模式不发起真实查询' });
    return;
  }
  const data = await metricExecService.previewModel(model, { size: req.query.size });
  ok(res, { executable: true, ...data });
});

module.exports = {
  columnTypes,
  getModels,
  getModel,
  createModel,
  updateModel,
  updateColumns,
  deleteModel,
  createTable,
  profileDimensions,
  getDimensionValues,
  saveDimensionValues,
  clearDimensionValues,
  previewDdl,
  previewModel,
};
