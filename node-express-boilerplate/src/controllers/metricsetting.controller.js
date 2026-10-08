const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { metricSettingService } = require('../services');

/**
 * 指标中心系统配置 HTTP 层（docs/API.md 1.12）。
 */

const getSettings = catchAsync(async (req, res) => {
  ok(res, await metricSettingService.getSettings());
});

const updateSettings = catchAsync(async (req, res) => {
  const result = await metricSettingService.updateSettings(req.body.settings, req.user && req.user.username);
  ok(res, result, { message: '保存成功' });
});

module.exports = { getSettings, updateSettings };
