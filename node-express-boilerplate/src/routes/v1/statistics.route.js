const express = require('express');
const statisticsController = require('../../controllers/statistics.controller');

/**
 * 运维统计路由（docs/API.md 第 1.5 节）。
 *
 * TODO 第二阶段挂鉴权：router.use(auth('getStatistics'))
 * Mock 阶段不鉴权，前端大盘一进来就要拉数据。
 */
const router = express.Router();

router.get('/overview', statisticsController.getOverview);

module.exports = router;
