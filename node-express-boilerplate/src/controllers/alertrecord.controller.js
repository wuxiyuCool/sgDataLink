const pick = require('../utils/pick');
const catchAsync = require('../utils/catchAsync');
const { ok, pageResult } = require('../utils/apiResponse');
const { alertService } = require('../services');

/**
 * 告警记录 HTTP 层（docs/API.md 第 1.10 节 /alert-records）。
 * 记录由触发链路（实例 failed / 管道 failed / 管道延迟超阈值）写入，这里只读 + 标记已读。
 */

const getAlertRecords = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['keyword', 'level', 'read', 'ruleId', 'targetType', 'targetId']);
  const options = pick(req.query, ['page', 'size', 'sort']);
  const result = await alertService.queryRecords(filter, options);
  pageResult(res, result);
});

const getAlertRecord = catchAsync(async (req, res) => {
  const result = await alertService.getRecordById(req.params.id);
  ok(res, result);
});

/** PATCH /alert-records/:id/read —— 标记已读 */
const markAlertRecordRead = catchAsync(async (req, res) => {
  const result = await alertService.markRecordRead(req.params.id);
  ok(res, result, { message: '已标记为已读' });
});

module.exports = {
  getAlertRecords,
  getAlertRecord,
  markAlertRecordRead,
};
