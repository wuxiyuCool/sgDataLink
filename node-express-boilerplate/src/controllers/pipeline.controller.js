const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { pipelineService } = require('../services');

/**
 * 数据管道 HTTP 层（docs/API.md 第 1.7 节）。
 * 只做出入参转换，业务全部在 services/pipeline.service.js。
 */

const getPipelines = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'status', 'sourceId', 'targetId']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await pipelineService.queryPipelines(filter, options);
  pageResult(res, result);
});

const getPipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.getPipelineById(req.params.id);
  ok(res, result);
});

const createPipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.createPipeline(req.body);
  ok(res, result, { message: '创建成功' });
});

const updatePipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.updatePipelineById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deletePipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.deletePipelineById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

/** POST /pipelines/:id/start —— 下发 cdc 快照给 Go 引擎 */
const startPipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.startPipeline(req.params.id, pick(req.body, ['trigger']));
  ok(res, result, { message: '启动指令已下发' });
});

/** POST /pipelines/:id/stop —— 停止管道 */
const stopPipeline = catchAsync(async (req, res) => {
  const result = await pipelineService.stopPipeline(req.params.id);
  ok(res, result, { message: '停止指令已下发' });
});

/** GET /pipelines/:id/status —— 实时状态（前端 3s 轮询） */
const getPipelineStatus = catchAsync(async (req, res) => {
  const result = await pipelineService.getPipelineStatus(req.params.id);
  ok(res, result);
});

module.exports = {
  getPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
  startPipeline,
  stopPipeline,
  getPipelineStatus,
};
