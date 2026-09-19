const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { syncTaskService, taskInstanceService } = require('../services');

/**
 * 同步任务 HTTP 层（docs/API.md 第 1.2 节）。
 */

const getTasks = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'syncMode', 'lastStatus', 'enabled']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await syncTaskService.queryTasks(filter, options);
  pageResult(res, result);
});

const getTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.getTaskById(req.params.id);
  ok(res, result);
});

const createTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.createTask(req.body);
  ok(res, result, { message: '创建成功' });
});

const updateTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.updateTaskById(req.params.id, req.body);
  ok(res, result, { message: '更新成功' });
});

const deleteTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.deleteTaskById(req.params.id);
  ok(res, { id: result.id, deleted: true }, { message: '删除成功' });
});

/** POST /tasks/:id/start —— 下发启动指令给 Go 引擎（trigger 可选：manual|cron|retry，缺省 manual） */
const startTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.startTask(req.params.id, pick(req.body, ['trigger', 'retryAttempt']));
  ok(res, result, { message: '启动指令已下发' });
});

/** POST /tasks/:id/stop —— 下发停止指令给 Go 引擎 */
const stopTask = catchAsync(async (req, res) => {
  const result = await syncTaskService.stopTask(req.params.id);
  ok(res, result, { message: '停止指令已下发' });
});

/** GET /tasks/:id/progress —— 状态 + 进度 + 读写行数 + 当前 offset */
const getTaskProgress = catchAsync(async (req, res) => {
  const result = await syncTaskService.getProgress(req.params.id);
  ok(res, result);
});

/** GET /tasks/:id/instances —— 该任务的实例分页列表 */
const getTaskInstances = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await taskInstanceService.queryTaskInstances(req.params.id, options);
  pageResult(res, result);
});

module.exports = {
  getTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  startTask,
  stopTask,
  getTaskProgress,
  getTaskInstances,
};
