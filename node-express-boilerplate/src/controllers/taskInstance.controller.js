const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { taskInstanceService } = require('../services');

/**
 * 任务运行实例 HTTP 层（docs/API.md 第 1.3 节）。
 */

const getInstances = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'taskId', 'status', 'trigger', 'pipelineId']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await taskInstanceService.queryInstances(filter, options);
  pageResult(res, result);
});

const getInstance = catchAsync(async (req, res) => {
  const result = await taskInstanceService.getInstanceById(req.params.id);
  ok(res, result);
});

/** GET /task-instances/:id/logs —— 实例日志分页，支持 level 筛选 */
const getInstanceLogs = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'level']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await taskInstanceService.getInstanceLogs(req.params.id, filter, options);
  pageResult(res, result);
});

/** GET /task-instances/:id/offsets —— 实例 offset 点位分页 */
const getInstanceOffsets = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await taskInstanceService.getInstanceOffsets(req.params.id, options);
  pageResult(res, result);
});

module.exports = {
  getInstances,
  getInstance,
  getInstanceLogs,
  getInstanceOffsets,
};
