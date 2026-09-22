const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { dataApiService, dataApiRuntimeService } = require('../services');

/**
 * 数据服务（Data API）管理端 HTTP 层（docs/API.md 第 1.9 节 /api/v1/data-apis）。
 * 对外运行时端点（/ds/{path}）在 controllers/ds.controller.js。
 */

const getDataApis = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'status', 'method', 'datasourceId']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await dataApiService.queryDataApis(filter, options);
  pageResult(res, result);
});

const getDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.getDataApiById(req.params.id);
  ok(res, result);
});

const createDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.createDataApi(req.body);
  ok(res, result, { message: '创建成功' });
});

const updateDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.updateDataApiById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.deleteDataApiById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

/** POST /data-apis/:id/publish —— 发布并生成 apiKey（已发布时幂等，沿用原 key） */
const publishDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.publishDataApi(req.params.id);
  ok(res, result, { message: '发布成功' });
});

/** POST /data-apis/:id/unpublish —— 下线，运行时立刻 404 */
const unpublishDataApi = catchAsync(async (req, res) => {
  const result = await dataApiService.unpublishDataApi(req.params.id);
  ok(res, result, { message: '已下线' });
});

/**
 * POST /data-apis/:id/invoke —— 「调试」代理：服务端内部直接调 runtime（不经 HTTP），
 * 原样透传 { httpStatus, body }，前端据此判断外部调用会得到什么响应。
 * 自定义查询参数：body.query 与 body.queryParams 等价（前端表单用的是 queryParams 这个名字），
 * 两者都会与平铺的 page/size/limit 合并成运行时 query。
 */
const invokeDataApi = catchAsync(async (req, res) => {
  const body = req.body || {};
  const flat = pick(body, ['page', 'size', 'limit']);
  const custom =
    typeof body.query === 'object' && body.query
      ? body.query
      : typeof body.queryParams === 'object' && body.queryParams
      ? body.queryParams
      : {};
  const query = { ...flat, ...custom };
  const result = await dataApiService.invokeDataApi(req.params.id, {
    query,
    // 显式带 apiKey（哪怕是空串）就以入参为准，让「调试」也能复现 40101/40102；
    // 完全没带时才由 service 回落到服务端已存的 key（见 dataApi.service.invokeDataApi）
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : req.get(dataApiRuntimeService.API_KEY_HEADER),
    ip: dataApiRuntimeService.clientIpOf(req),
  });
  ok(res, result);
});

/** GET /data-apis/:id/stats —— 调用统计（invokeCount / errorCount / avgLatencyMs / 最近 7 天趋势） */
const getDataApiStats = catchAsync(async (req, res) => {
  const result = await dataApiService.getStats(req.params.id);
  ok(res, result);
});

/**
 * GET /data-apis/meta/tables?datasourceId=&keyword= —— 1.9.1 表清单。
 * 真实模式查 information_schema / ALL_TABLES，演示模式返回内置表；数据源不存在 40401。
 */
const listMetaTables = catchAsync(async (req, res) => {
  const result = await dataApiService.listMetaTables(pick(req.query, ['datasourceId', 'keyword']));
  ok(res, result);
});

/** GET /data-apis/meta/columns?datasourceId=&tableName= —— 1.9.1 列清单 */
const listMetaColumns = catchAsync(async (req, res) => {
  const result = await dataApiService.listMetaColumns(pick(req.query, ['datasourceId', 'tableName']));
  ok(res, result);
});

module.exports = {
  getDataApis,
  getDataApi,
  createDataApi,
  updateDataApi,
  deleteDataApi,
  publishDataApi,
  unpublishDataApi,
  invokeDataApi,
  getDataApiStats,
  listMetaTables,
  listMetaColumns,
};
