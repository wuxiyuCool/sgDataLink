const express = require('express');
const dsController = require('../controllers/ds.controller');

/**
 * 数据服务运行时端点（docs/API.md 第 1.9 节）：`GET /ds/{path}`。
 *
 * 与 /api/v1 管理前缀平级，由 src/app.js 直接挂载，原因：
 * - 它是「对外发布的数据接口」，不是管理接口，地址里不该带版本号与内部前缀；
 * - 鉴权方式是 apiKey（X-API-Key 头或 apiKey 查询参数），不是脚手架的 JWT。
 *
 * 这里不挂 middlewares/validate：query 参数是每条 API 自定义的（定义里的 queryParams），
 * 形状不固定，分页参数 page/size/limit 由 services/dataApiRuntime.service.js 自己解析。
 */
const router = express.Router();

router.get('/:path', dsController.invoke);

module.exports = router;
