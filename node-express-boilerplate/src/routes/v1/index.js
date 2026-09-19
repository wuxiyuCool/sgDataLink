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
