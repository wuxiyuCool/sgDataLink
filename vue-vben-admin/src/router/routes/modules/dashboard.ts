import type { AppRouteModule } from '/@/router/types'

import { LAYOUT } from '/@/router/constant'

/**
 * 可视化监控（本文件原为 vben 演示菜单 Dashboard：分析页 / 工作台，demo 项已移出菜单）。
 *
 * 四个大屏页由原「任务监控大盘」（/databridge/dashboard）拆分而来：
 * - 监控总览 /monitor/overview  全站 KPI + 趋势 + 分布 + 告警（30s 轮询，首页）
 * - 运行监控 /monitor/running   运行实例 + 进度采样 + 实时日志流（3s / 10s）
 * - 管道监控 /monitor/pipeline  单管道 QPS / 延迟 / 变更行数 / CDC 位点 + 实例日志（3s / 10s）
 * - 服务监控 /monitor/dataapi   调用统计 + 7 日成功/错误趋势 + 调用明细（30s / 10s）
 *
 * meta.title 直接写中文：vben 的 t() 对不含 "." 的 key 原样返回，无需扩语言包。
 * 四页均参与 keep-alive（不设 ignoreKeepAlive，本地采样曲线切页回来仍连续）。
 */
const monitor: AppRouteModule = {
  path: '/monitor',
  name: 'Monitor',
  component: LAYOUT,
  redirect: '/monitor/overview',
  meta: {
    orderNo: 10,
    icon: 'ion:stats-chart-outline',
    title: '可视化监控',
  },
  children: [
    {
      path: 'overview',
      name: 'MonitorOverview',
      component: () => import('/@/views/monitor/overview/index.vue'),
      meta: {
        title: '监控总览',
        icon: 'ion:grid-outline',
        keepAlive: true,
      },
    },
    {
      path: 'running',
      name: 'MonitorRunning',
      component: () => import('/@/views/monitor/running/index.vue'),
      meta: {
        title: '运行监控',
        icon: 'ion:rocket-outline',
        keepAlive: true,
      },
    },
    {
      path: 'pipeline',
      name: 'MonitorPipeline',
      component: () => import('/@/views/monitor/pipeline/index.vue'),
      meta: {
        title: '管道监控',
        icon: 'ion:pulse-outline',
        keepAlive: true,
      },
    },
    {
      path: 'dataapi',
      name: 'MonitorDataApi',
      component: () => import('/@/views/monitor/dataapi/index.vue'),
      meta: {
        title: '服务监控',
        icon: 'ion:cloud-upload-outline',
        keepAlive: true,
      },
    },
  ],
}

export default monitor
