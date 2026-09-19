const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { dataflowService } = require('../services');

/**
 * 数据开发（ETL 画布）HTTP 层（docs/API.md 第 1.8 节）。
 */

const getDataflows = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'lastStatus', 'enabled']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await dataflowService.queryDataflows(filter, options);
  pageResult(res, result);
});

const getDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.getDataflowById(req.params.id);
  ok(res, result);
});

const createDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.createDataflow(req.body);
  ok(res, result, { message: '创建成功' });
});

const updateDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.updateDataflowById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.deleteDataflowById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

/** POST /dataflows/:id/run —— 按 full 模式下发引擎，返回 { dataflowId, instanceId, status } */
const runDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.runDataflow(req.params.id, pick(req.body, ['trigger']));
  ok(res, result, { message: '运行指令已下发' });
});

/** POST /dataflows/:id/stop */
const stopDataflow = catchAsync(async (req, res) => {
  const result = await dataflowService.stopDataflow(req.params.id);
  ok(res, result, { message: '停止指令已下发' });
});

/**
 * GET /dataflows/:id/progress —— 结构与 /tasks/:id/progress 一致。
 * 契约 1.8「taskId 换 dataflowId」：这里额外给出 dataflowId 键（值同 taskId），
 * 前端 DataflowProgress 类型读的正是 dataflowId；run.service 的通用结构保留 taskId，
 * 便于与实例列表 / 引擎回报里的同一 id 对照。
 */
const getDataflowProgress = catchAsync(async (req, res) => {
  const result = await dataflowService.getProgress(req.params.id);
  ok(res, { ...result, dataflowId: result.taskId });
});

module.exports = {
  getDataflows,
  getDataflow,
  createDataflow,
  updateDataflow,
  deleteDataflow,
  runDataflow,
  stopDataflow,
  getDataflowProgress,
};
