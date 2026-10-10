const express = require('express');
const authRoute = require('./auth.route');
const userRoute = require('./user.route');
const docsRoute = require('./docs.route');
const healthRoute = require('./health.route');
const datasourceRoute = require('./datasource.route');
const taskRoute = require('./task.route');
const taskInstanceRoute = require('./taskInstance.route');
const statisticsRoute = require('./statistics.route');
const engineRoute = require('./engine.route');
const pipelineRoute = require('./pipeline.route');
const dataflowRoute = require('./dataflow.route');
const dataApiRoute = require('./dataapi.route');
const alertRuleRoute = require('./alertrule.route');
const alertRecordRoute = require('./alertrecord.route');
const lineageRoute = require('./lineage.route');
// 指标中心（契约 1.12）
const metricRoute = require('./metric.route');
const metricDomainRoute = require('./metricdomain.route');
const metricModelRoute = require('./metricmodel.route');
const metricModelCategoryRoute = require('./metricmodelcategory.route');
const metricSettingRoute = require('./metricsetting.route');
const metricDashboardRoute = require('./metricdashboard.route');
const metricTaskRoute = require('./metrictask.route');
const metricChatRoute = require('./metricchat.route');
const metricTermRoute = require('./metricterm.route');
const metricExampleRoute = require('./metricexample.route');
const metricLogRoute = require('./metriclog.route');
const chatRuntimeRoute = require('./chat.route');
const config = require('../../config/config');

const router = express.Router();

const defaultRoutes = [
  // ---- 脚手架自带路由（保留原有 auth 鉴权链路）----
  {
    path: '/auth',
    route: authRoute,
  },
  {
    path: '/users',
    route: userRoute,
  },
  // ---- DataBridge 管理后端路由（docs/API.md 第 1 节，Mock 阶段不鉴权）----
  {
    path: '/health',
    route: healthRoute,
  },
  {
    path: '/datasources',
    route: datasourceRoute,
  },
  {
    path: '/tasks',
    route: taskRoute,
  },
  {
    path: '/task-instances',
    route: taskInstanceRoute,
  },
  {
    path: '/statistics',
    route: statisticsRoute,
  },
  {
    path: '/pipelines',
    route: pipelineRoute,
  },
  {
    path: '/dataflows',
    route: dataflowRoute,
  },
  {
    path: '/data-apis',
    route: dataApiRoute,
  },
  {
    path: '/alert-rules',
    route: alertRuleRoute,
  },
  {
    path: '/alert-records',
    route: alertRecordRoute,
  },
  {
    path: '/lineage',
    route: lineageRoute,
  },
  {
    path: '/engine',
    route: engineRoute,
  },
  // ---- 指标中心（契约 1.12，路由组内已挂 JWT/admin 鉴权）----
  {
    path: '/metric-dashboard',
    route: metricDashboardRoute,
  },
  {
    path: '/metric-domains',
    route: metricDomainRoute,
  },
  {
    path: '/metrics',
    route: metricRoute,
  },
  {
    path: '/metric-models',
    route: metricModelRoute,
  },
  {
    // 建模分层树的分类（契约 1.16）：与 /metric-models 是不同的挂载段，互不影响匹配
    path: '/metric-model-categories',
    route: metricModelCategoryRoute,
  },
  {
    path: '/metric-settings',
    route: metricSettingRoute,
  },
  {
    path: '/metric-tasks',
    route: metricTaskRoute,
  },
  {
    path: '/metric-chat',
    route: metricChatRoute,
  },
  {
    path: '/metric-terms',
    route: metricTermRoute,
  },
  {
    path: '/metric-examples',
    route: metricExampleRoute,
  },
  {
    path: '/metric-logs',
    route: metricLogRoute,
  },
  {
    // 问数对外服务（契约 1.12 增补）：X-CHAT-KEY 免 JWT
    path: '/chat',
    route: chatRuntimeRoute,
  },
];

const devRoutes = [
  // routes available only in development mode
  {
    path: '/docs',
    route: docsRoute,
  },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

/* istanbul ignore next */
if (config.env === 'development') {
  devRoutes.forEach((route) => {
    router.use(route.path, route.route);
  });
}

module.exports = router;
