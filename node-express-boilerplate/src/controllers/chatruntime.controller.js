const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { accountService, metricChatService } = require('../services');

/**
 * 问数对外服务运行时（契约 1.12 增补）：X-CHAT-KEY / chatKey 查询参数鉴权，
 * 复用 metricChat 主链路；调用审计 userName 带 (apikey) 后缀、matched.source=chatKey。
 */

const ask = catchAsync(async (req, res) => {
  const rawKey = req.get('x-chat-key') || req.query.chatKey || '';
  const { user } = await accountService.resolveChatKey(rawKey);
  const result = await metricChatService.ask(
    {
      question: req.body.question,
      sessionId: req.body.sessionId,
      dateRange: req.body.dateRange || null,
      source: 'chatKey',
    },
    { username: `${user.username} (apikey)` }
  );
  ok(res, result);
});

module.exports = { ask };
