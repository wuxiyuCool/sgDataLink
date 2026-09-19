import type { AppRouteModule } from '/@/router/types'

import { getParentLayout, LAYOUT } from '/@/router/constant'

/**
 * DataBridge 平台菜单（对标 FineDataLink 的三大分区）
 *
 * 说明：
 * 1. meta.title 直接使用中文字符串 —— vben 的菜单/面包屑/标签页通过 useI18n 的 t() 渲染，
 *    遇到不含 "." 的 key 会原样返回，因此无需新增语言包。
 * 2. 分组节点（数据集成 / 数据服务 / 运维监控）用 getParentLayout() 占位：
 *    vben 的 flatMultiLevelRoutes 会把三级路由提升为二级后交给 LAYOUT 渲染，
 *    占位组件本身不会被真实挂载，仅用于生成菜单层级。
 * 3. 分组内的叶子路由一律使用「绝对路径」（/databridge/xxx），并配合
 *    meta.hidePathForChildren，保证菜单缩进分组的同时不改变原有页面 URL
 *    （数据源、任务、映射、大盘、日志这 5 个历史路径保持不动）。
 */
const databridge: AppRouteModule = {
  path: '/databridge',
  name: 'DataBridge',
  component: LAYOUT,
  redirect: '/databridge/datasource',
  meta: {
    orderNo: 20,
    icon: 'ion:cube-outline',
    title: 'DataBridge 数据同步',
  },
  children: [
    {
      // ------------------------- 一、数据集成 -------------------------
      path: 'integration',
      name: 'DatabridgeIntegration',
      component: getParentLayout('DatabridgeIntegration'),
      meta: {
        title: '数据集成',
        icon: 'ion:layers-outline',
        orderNo: 10,
        hidePathForChildren: true,
      },
      children: [
        {
          path: '/databridge/datasource',
          name: 'DatabridgeDatasource',
          component: () => import('/@/views/databridge/datasource/index.vue'),
          meta: {
            title: '数据源管理',
            icon: 'ion:server-outline',
          },
        },
        {
          path: '/databridge/task',
          name: 'DatabridgeTask',
          component: () => import('/@/views/databridge/task/index.vue'),
          meta: {
            title: '同步任务管理',
            icon: 'ion:git-network-outline',
          },
        },
        {
          path: '/databridge/pipeline',
          name: 'DatabridgePipeline',
          component: () => import('/@/views/databridge/pipeline/index.vue'),
          meta: {
            title: '数据管道',
            icon: 'ion:pulse-outline',
          },
        },
        {
          path: '/databridge/dataflow',
          name: 'DatabridgeDataflow',
          component: () => import('/@/views/databridge/dataflow/index.vue'),
          meta: {
            title: '数据开发',
            icon: 'ion:construct-outline',
          },
        },
        {
          path: '/databridge/mapping',
          name: 'DatabridgeMapping',
          component: () => import('/@/views/databridge/mapping/index.vue'),
          meta: {
            title: '字段映射配置',
            icon: 'ion:swap-horizontal-outline',
          },
        },
      ],
    },
    {
      // ------------------------- 二、数据服务 -------------------------
      path: 'service',
      name: 'DatabridgeService',
      component: getParentLayout('DatabridgeService'),
      meta: {
        title: '数据服务',
        icon: 'ion:cloud-outline',
        orderNo: 20,
        hidePathForChildren: true,
      },
      children: [
        {
          path: '/databridge/dataapi',
          name: 'DatabridgeDataApi',
          component: () => import('/@/views/databridge/dataapi/index.vue'),
          meta: {
            title: 'Data API',
            icon: 'ion:code-slash-outline',
          },
        },
      ],
    },
    {
      // ------------------------- 三、运维监控 -------------------------
      path: 'ops',
      name: 'DatabridgeOps',
      component: getParentLayout('DatabridgeOps'),
      meta: {
        title: '运维监控',
        icon: 'ion:monitor-outline',
        orderNo: 30,
        hidePathForChildren: true,
      },
      children: [
        {
          path: '/databridge/dashboard',
          name: 'DatabridgeDashboard',
          component: () => import('/@/views/databridge/dashboard/index.vue'),
          meta: {
            title: '任务监控大盘',
            icon: 'ion:speedometer-outline',
          },
        },
        {
          path: '/databridge/log',
          name: 'DatabridgeLog',
          component: () => import('/@/views/databridge/log/index.vue'),
          meta: {
            title: '运行日志',
            icon: 'ion:document-text-outline',
          },
        },
        {
          path: '/databridge/alert',
          name: 'DatabridgeAlert',
          component: () => import('/@/views/databridge/alert/index.vue'),
          meta: {
            title: '告警管理',
            icon: 'ion:notifications-outline',
          },
        },
        {
          path: '/databridge/lineage',
          name: 'DatabridgeLineage',
          component: () => import('/@/views/databridge/lineage/index.vue'),
          meta: {
            title: '数据血缘',
            icon: 'ion:git-branch-outline',
          },
        },
      ],
    },
    {
      // ---------------- 数据开发画布（不在菜单中，由列表页跳转进入） ----------------
      path: 'dataflow/canvas',
      name: 'DatabridgeDataflowCanvas',
      component: () => import('/@/views/databridge/dataflow/canvas.vue'),
      meta: {
        title: '数据开发画布',
        hideMenu: true,
        hideTab: true,
        // 页签/面包屑仍高亮「数据开发」，避免进入画布后菜单失焦
        currentActiveMenu: '/databridge/dataflow',
        ignoreKeepAlive: true,
      },
    },
  ],
}

export default databridge
