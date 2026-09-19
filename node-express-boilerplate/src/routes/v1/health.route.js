const express = require('express');
const healthController = require('../../controllers/health.controller');

/**
 * 健康检查（docs/API.md 第 1.5 节）：GET /api/v1/health
 * 供 docker / k8s 探针与前端连通性自检使用，不鉴权。
 */
const router = express.Router();

router.get('/', healthController.getHealth);

module.exports = router;
