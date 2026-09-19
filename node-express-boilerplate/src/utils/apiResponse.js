const httpStatus = require('http-status');

/**
 * DataBridge 统一响应信封（docs/API.md 第 0 节，兼容 vben v2 defHttp 解析）：
 * { code: 0, message: 'success', result: <payload>, timestamp: 1700000000000 }
 *
 * 注意：脚手架自带路由（/auth /users）保持原样返回裸对象，
 * 信封只用于新增的 DataBridge 路由。
 */
const envelope = (result = null, message = 'success') => ({
  code: 0,
  message,
  result,
  timestamp: Date.now(),
});

/**
 * 200 + 信封。Mock 阶段所有成功响应（含新增 / 删除）都返回 HTTP 200，
 * 让前端只需判断 code；创建类接口如需 REST 语义可传 statusCode。
 */
const ok = (res, result = null, { message = 'success', statusCode = httpStatus.OK } = {}) =>
  res.status(statusCode).send(envelope(result, message));

/**
 * 分页信封：result = { items, total, page, size, pages }
 */
const pageResult = (res, page, { message = 'success' } = {}) => {
  const result = {
    items: (page && page.items) || [],
    total: (page && page.total) || 0,
    page: (page && page.page) || 1,
    size: (page && page.size) || 0,
    pages: (page && page.pages) || 0,
  };
  return ok(res, result, { message });
};

module.exports = {
  envelope,
  ok,
  pageResult,
};
