const express = require('express');
const lineageController = require('../../controllers/lineage.controller');

/**
 * 数据血缘路由（docs/API.md 第 1.10 节）。
 * Mock 阶段图是实时聚合的，没有需要入参的地方，因此不挂 validate。
 */
const router = express.Router();

router.get('/graph', lineageController.getGraph);

module.exports = router;
