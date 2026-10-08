const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { metricTaskService } = require('../services');

/**
 * 清洗汇总任务 HTTP 层（docs/API.md 1.12 §7.2）。
 */

const getTasks = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['domainId', 'status', 'lastStatus']);
  const options = pick(req.query, ['keyword', 'page', 'size', 'sort']);
  pageResult(res, await metricTaskService.queryTasks(filter, options));
});

const getTask = catchAsync(async (req, res) => {
  ok(res, await metricTaskService.getTask(req.params.id));
});

const createTask = catchAsync(async (req, res) => {
  const result = await metricTaskService.saveTask(req.body, null, req.user && req.user.username);
  ok(res, result, { message: '创建成功' });
});

const updateTask = catchAsync(async (req, res) => {
  const result = await metricTaskService.updateTask(req.params.id, req.body, req.user && req.user.username);
  ok(res, result, { message: '更新成功' });
});

const deleteTask = catchAsync(async (req, res) => {
  ok(res, await metricTaskService.deleteTask(req.params.id), { message: '删除成功' });
});

/** 手动执行（同步跑完再返回，含 writeRows） */
const run = catchAsync(async (req, res) => {
  ok(res, await metricTaskService.runTask(req.params.id, 'manual'), { message: '执行完成' });
});

/** 保存前查看将要执行的语句（不执行） */
const preview = catchAsync(async (req, res) => {
  ok(res, await metricTaskService.previewPlan(req.body || {}));
});

const getRuns = catchAsync(async (req, res) => {
  const options = pick(req.query, ['page', 'size', 'sort']);
  pageResult(res, await metricTaskService.queryRuns(req.params.id, options));
});

module.exports = { getTasks, getTask, createTask, updateTask, deleteTask, run, preview, getRuns };
