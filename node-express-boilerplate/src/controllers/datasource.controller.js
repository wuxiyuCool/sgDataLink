const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { datasourceService } = require('../services');

/**
 * 数据源 HTTP 层（docs/API.md 第 1.1 节）。
 * 只做出入参转换，业务全部在 services/datasource.service.js。
 */

const getDataSources = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'type', 'status']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await datasourceService.queryDataSources(filter, options);
  pageResult(res, result);
});

const getDataSource = catchAsync(async (req, res) => {
  const result = await datasourceService.getDataSourceById(req.params.id);
  ok(res, result);
});

const createDataSource = catchAsync(async (req, res) => {
  const result = await datasourceService.createDataSource(req.body);
  ok(res, result, { message: '创建成功' });
});

const updateDataSource = catchAsync(async (req, res) => {
  const result = await datasourceService.updateDataSourceById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteDataSource = catchAsync(async (req, res) => {
  const result = await datasourceService.deleteDataSourceById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

/** POST /datasources/test —— 传入未保存配置 */
const testDataSource = catchAsync(async (req, res) => {
  const result = await datasourceService.testConnection(req.body);
  ok(res, result, { message: result.success ? 'success' : result.message });
});

/** POST /datasources/:id/test —— 已保存数据源 */
const testDataSourceById = catchAsync(async (req, res) => {
  const result = await datasourceService.testConnectionById(req.params.id);
  ok(res, result, { message: result.success ? 'success' : result.message });
});

module.exports = {
  getDataSources,
  getDataSource,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  testDataSource,
  testDataSourceById,
};
