const express = require('express');
const auth = require('../../middlewares/auth');
const metricDashboardController = require('../../controllers/metricdashboard.controller');

/**
 * 指标中心首页概览路由（docs/API.md 1.12）：JWT。
 */
const router = express.Router();

router.use(auth());
router.get('/', metricDashboardController.getDashboard);

module.exports = router;
