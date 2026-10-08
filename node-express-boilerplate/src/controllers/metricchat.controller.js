const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { metricChatService } = require('../services');

/**
 * 智能问数 HTTP 层（docs/API.md 1.12 §7.4）：ask + 术语/示例/日志附属管理。
 */

const ask = catchAsync(async (req, res) => {
  const result = await metricChatService.ask(
    {
      question: req.body.question,
      sessionId: req.body.sessionId,
      dateRange: req.body.dateRange || null,
    },
    req.user || {}
  );
  ok(res, result);
});

const getTerms = catchAsync(async (req, res) => {
  const query = pick(req.query, ['keyword', 'page', 'size', 'sort']);
  pageResult(res, await metricChatService.listTerms(query));
});

const createTerm = catchAsync(async (req, res) => {
  ok(res, await metricChatService.saveTerm(req.body || {}), { message: '创建成功' });
});

const updateTerm = catchAsync(async (req, res) => {
  ok(res, await metricChatService.updateTerm(req.params.id, req.body || {}), { message: '更新成功' });
});

const deleteTerm = catchAsync(async (req, res) => {
  ok(res, await metricChatService.deleteTerm(req.params.id), { message: '删除成功' });
});

const getExamples = catchAsync(async (req, res) => {
  const query = pick(req.query, ['keyword', 'page', 'size', 'sort']);
  pageResult(res, await metricChatService.listExamples(query));
});

const createExample = catchAsync(async (req, res) => {
  ok(res, await metricChatService.saveExample(req.body || {}), { message: '创建成功' });
});

const updateExample = catchAsync(async (req, res) => {
  ok(res, await metricChatService.updateExample(req.params.id, req.body || {}), { message: '更新成功' });
});

const deleteExample = catchAsync(async (req, res) => {
  ok(res, await metricChatService.deleteExample(req.params.id), { message: '删除成功' });
});

const getLogs = catchAsync(async (req, res) => {
  const query = pick(req.query, ['keyword', 'status', 'result', 'userName', 'startTime', 'endTime', 'page', 'size']);
  pageResult(res, await metricChatService.listQueryLogs(query));
});

const logToExample = catchAsync(async (req, res) => {
  ok(res, await metricChatService.logToExample(req.params.id), { message: '已转为示例' });
});

/** 多轮上下文（内存态，契约 1.12）：GET 查询 / POST 清空 */
const getSession = catchAsync(async (req, res) => {
  ok(res, await metricChatService.getSessionHistory(req.params.id));
});

const clearSession = catchAsync(async (req, res) => {
  ok(res, await metricChatService.clearSession(req.params.id), { message: '已清空会话上下文' });
});

module.exports = {
  ask,
  getSession,
  clearSession,
  getTerms,
  createTerm,
  updateTerm,
  deleteTerm,
  getExamples,
  createExample,
  updateExample,
  deleteExample,
  getLogs,
  logToExample,
};
