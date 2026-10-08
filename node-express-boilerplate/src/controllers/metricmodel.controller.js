const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const config = require('../config/config');
const { ok, pageResult } = require('../utils/apiResponse');
const { metricModelService, metricExecService } = require('../services');

/**
 * 数据模型 HTTP 层（docs/API.md 1.12）。
 */

const getModels = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['domainId', 'layer', 'datasourceId', 'status']);
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
  ok(res, await metricModelService.deleteModel(req.params.id), { message: '删除成功' });
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

module.exports = { getModels, getModel, createModel, updateModel, updateColumns, deleteModel, previewDdl, previewModel };
