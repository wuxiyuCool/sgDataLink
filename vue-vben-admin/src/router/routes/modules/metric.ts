import type { AppRouteModule } from '/@/router/types'

import { LAYOUT } from '/@/router/constant'

/**
 * 指标中心菜单（契约 1.12，开发文档 docs/METRIC-DEV.md）。
 * M5a 先行上线「系统配置」（admin）；首页/域建模/指标/任务/问数等页面按 M6a/M6b 节奏补齐。
 */
const metric: AppRouteModule = {
  path: '/metric',
  name: 'MetricCenter',
  component: LAYOUT,
  redirect: '/metric/setting',
  meta: {
    orderNo: 25,
    icon: 'ion:stats-chart-outline',
    title: '指标中心',
  },
  children: [
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
