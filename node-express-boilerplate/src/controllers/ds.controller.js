const catchAsync = require('../utils/catchAsync');
const { ok } = require('../utils/apiResponse');
const { dataApiRuntimeService } = require('../services');

/**
 * 数据服务运行时 HTTP 层（docs/API.md 第 1.9 节，对外端点 GET /ds/{path}）。
 *
 * 这一层刻意做得很薄：只负责把头/查询参数交给 services/dataApiRuntime.service.js，
 * 鉴权（401/40101、40102）、白名单（403/40301）、限流（429/42901）、
 * 未发布或路径不存在（404/40404）都以带 bizCode 的 ApiError 抛出，
 * 由 middlewares/error.js 渲染成统一信封 + 契约指定的 HTTP 状态码。
 * 例外是 1.9.3 forward 模式：runtime 返回 {forward:true,...} 时按契约原样透传
 * 下游状态码与响应体，不再包统一信封。
 */
const invoke = catchAsync(async (req, res) => {
  const result = await dataApiRuntimeService.invokeByPath(req.params.path, {
    apiKey: req.get(dataApiRuntimeService.API_KEY_HEADER),
    ip: dataApiRuntimeService.clientIpOf(req),
    query: req.query,
  });
  if (result && result.forward) {
    res
      .status(result.httpStatus)
      .set('Content-Type', result.contentType || 'application/octet-stream')
      .send(result.body);
    return;
  }
  ok(res, result);
});

module.exports = {
  invoke,
};
