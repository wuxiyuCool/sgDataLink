import type { AppRouteModule } from '/@/router/types'

import { LAYOUT } from '/@/router/constant'

/**
 * 指标中心菜单（契约 1.12，开发文档 docs/METRIC-DEV.md）。
 * M6a：首页概览/指标域/数据建模/指标广场/智能问数；M5a：系统配置（admin）；任务管理在 M6b。
 */
const metric: AppRouteModule = {
  path: '/metric',
  name: 'MetricCenter',
  component: LAYOUT,
  redirect: '/metric/home',
  meta: {
    orderNo: 25,
    icon: 'ion:stats-chart-outline',
    title: '指标中心',
  },
  children: [
    {
      path: 'home',
      name: 'MetricHome',
      component: () => import('/@/views/metric/home/index.vue'),
      meta: {
        title: '首页概览',
        icon: 'ion:pie-chart-outline',
      },
    },
    {
      path: 'domains',
      name: 'MetricDomains',
      component: () => import('/@/views/metric/domain/index.vue'),
      meta: {
        title: '指标域',
        icon: 'ion:albums-outline',
      },
    },
    {
      path: 'models',
      name: 'MetricModels',
      component: () => import('/@/views/metric/model/index.vue'),
      meta: {
        title: '数据建模',
        icon: 'ion:grid-outline',
      },
    },
    {
      path: 'metrics',
      name: 'MetricList',
      component: () => import('/@/views/metric/metric/index.vue'),
      meta: {
        title: '指标广场',
        icon: 'ion:calc-outline',
      },
    },
    {
      path: 'chat',
      name: 'MetricChat',
      component: () => import('/@/views/metric/chat/index.vue'),
      meta: {
        title: '智能问数',
        icon: 'ion:chatbubbles-outline',
      },
    },
    {
      path: 'tasks',
      name: 'MetricTasks',
      component: () => import('/@/views/metric/task/index.vue'),
      meta: {
        title: '任务管理',
        icon: 'ion:hammer-outline',
      },
    },
    {
      path: 'setting',
      name: 'MetricSetting',
      component: () => import('/@/views/metric/setting/index.vue'),
      meta: {
        title: '系统配置',
        icon: 'ion:settings-outline',
        roles: ['admin'],
      },
    },
  ],
}

export default metric
