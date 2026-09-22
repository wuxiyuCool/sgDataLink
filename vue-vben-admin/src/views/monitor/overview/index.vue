<template>
  <PageWrapper
    title="监控总览"
    content="数据来源：GET /statistics/overview 单接口喂满本页（KPI / recentTrend / taskModeDistribution / datasourceTypes / recentAlerts），30 秒轮询一次；运行、管道、服务三个专项大屏各自取数，见下方导航。"
  >
    <template #headerContent>
      <MonitorToolbar
        v-model="autoRefresh"
        rule="KPI 与图表 30s"
        :updated="statsUpdatedAt"
        :hint="`统计概览 ${statsUpdatedAt || '-'} / 管理后端 ${healthUpdatedAt || '-'}`"
        :loading="manualLoading"
        @refresh="handleRefreshAll"
      >
        <span>
          管理后端：
          <Tag :color="healthTag.color">{{ healthTag.text }}</Tag>
        </span>
      </MonitorToolbar>
    </template>

    <div class="monitor-body">
      <!-- 1. 6 枚 KPI：全部来自 overview 单接口 -->
      <KpiCards
        class="mb-3"
        :overview="overview"
        :loading="overviewLoading"
        :error="overviewError"
        @dismiss-error="overviewError = ''"
      />

      <!-- 2. 近 7 天趋势 + 任务类型环形 + 数据源类型饼图 -->
      <Row :gutter="[16, 16]" class="mb-3">
        <Col :xs="24" :lg="10">
          <TrendChart :trend="trend" :loading="overviewLoading" :error="overviewError" />
        </Col>
        <Col :xs="24" :sm="12" :lg="7">
          <CategoryPieChart
            title="任务类型分布"
            icon="ant-design:appstore-outlined"
            hint="口径：同步任务 full/incremental + 数据管道算 cdc + 数据开发算 dataflow（overview.taskModeDistribution）"
            donut
            :data="modeData"
            :center-value="modeTotal"
            center-label="运行体总数"
            :loading="overviewLoading"
            :error="overviewError"
            empty-text="暂无任务与管道"
          />
        </Col>
        <Col :xs="24" :sm="12" :lg="7">
          <CategoryPieChart
            title="数据源类型分布"
            icon="ant-design:cluster-outlined"
            hint="口径：按数据源 type 分组计数（overview.datasourceTypes）"
            :data="datasourceData"
            :loading="overviewLoading"
            :error="overviewError"
            empty-text="暂无数据源"
          />
        </Col>
      </Row>

      <!-- 3. 最新告警流 + 三个专项大屏的入口（带各自的关键计数） -->
      <Row :gutter="[16, 16]">
        <Col :xs="24" :lg="14">
          <AlertFeedPanel
            :items="alerts"
            :loading="overviewLoading"
            :error="overviewError"
            @read="handleMarkAlertRead"
          />
        </Col>
        <Col :xs="24" :lg="10">
          <PanelCard
            title="专项监控大屏"
            icon="ant-design:fund-projection-screen-outlined"
            hint="总览只做「一眼看全局」，明细按运行 / 管道 / 服务三个维度独立成页，各页轮询节奏与数据源不同"
            :skeleton="false"
          >
            <ul class="nav-list">
              <li
                v-for="page in MONITOR_PAGES"
                :key="page.path"
                class="nav-list__item"
                @click="router.push(page.path)"
              >
                <Icon :icon="page.icon" :color="page.color" class="nav-list__icon" />
                <div class="nav-list__main">
                  <div class="nav-list__title">{{ page.title }}</div>
                  <div class="nav-list__desc">{{ page.desc }}</div>
                </div>
                <Tag :color="page.color" class="nav-list__badge">{{ counterOf(page.path) }}</Tag>
                <Icon icon="ant-design:right-outlined" class="nav-list__arrow" />
              </li>
            </ul>
          </PanelCard>
        </Col>
      </Row>
    </div>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, onUnmounted, ref, unref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { Col, Row, Tag } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getHealthApi } from '/@/api/databridge/health'
  import type { HealthResult } from '/@/api/databridge/health'
  import { getStatisticsOverviewApi } from '/@/api/databridge/statistics'
  import type { StatisticsOverview } from '/@/api/databridge/statistics'
  import { markAlertRecordReadApi } from '/@/api/databridge/alert'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { getDatasourceTypeLabel, formatTimeAxis } from '/@/views/databridge/data'
  import {
    DATASOURCE_TYPE_CHART_COLORS,
    MONITOR_PAGES,
    OVERVIEW_POLL_INTERVAL,
    TASK_MODE_META,
  } from '../monitor.data'
  import type { ChartDatum } from '../monitor.data'
  import AlertFeedPanel from '../components/AlertFeedPanel.vue'
  import KpiCards from '../components/KpiCards.vue'
  import MonitorToolbar from '../components/MonitorToolbar.vue'
  import PanelCard from '../components/PanelCard.vue'
  import CategoryPieChart from '../components/CategoryPieChart.vue'
  import TrendChart from '../components/TrendChart.vue'

  const router = useRouter()
  const { createMessage } = useMessage()

  const autoRefresh = ref(true)
  const manualLoading = ref(false)
  const statsUpdatedAt = ref('')
  const healthUpdatedAt = ref('')

  const overview = ref<StatisticsOverview | null>(null)
  const overviewLoading = ref(false)
  const overviewError = ref('')
  const health = ref<HealthResult | null>(null)

  const trend = computed(() => overview.value?.recentTrend ?? [])
  const alerts = computed(() => overview.value?.recentAlerts ?? [])

  const modeData = computed<ChartDatum[]>(() =>
    (overview.value?.taskModeDistribution ?? []).map((item) => ({
      name: TASK_MODE_META[item.mode]?.label ?? item.mode,
      value: Number(item.count) || 0,
      color: TASK_MODE_META[item.mode]?.color,
    })),
  )
  const modeTotal = computed(() => modeData.value.reduce((sum, item) => sum + item.value, 0))

  const datasourceData = computed<ChartDatum[]>(() =>
    (overview.value?.datasourceTypes ?? []).map((item) => ({
      name: getDatasourceTypeLabel(item.type),
      value: Number(item.count) || 0,
      color: DATASOURCE_TYPE_CHART_COLORS[item.type],
    })),
  )

  const healthTag = computed(() => {
    const data = unref(health)
    if (!data) return { text: '未知', color: 'default' }
    if (data.status === 'ok') {
      const mode = data.storage
        ? `（${data.storage === 'mysql' ? 'MySQL 持久化' : '内存 mock'}）`
        : data.mock
        ? '（mock）'
        : ''
      return { text: `${data.service}${mode}`, color: 'success' }
    }
    return { text: data.status || '异常', color: 'error' }
  })

  /** 导航卡上的计数徽标：让总览成为「跳板」，不必进子页才知道有没有东西 */
  function counterOf(path: string) {
    const data = overview.value
    if (!data) return '-'
    if (path === '/monitor/running')
      return `${data.todayRunning ?? data.runningInstances ?? 0} 个在跑`
    if (path === '/monitor/pipeline') return `${data.runningPipelines?.count ?? 0} 条运行`
    return `${data.dataApiTotal ?? 0} 个服务`
  }

  async function loadOverview() {
    overviewLoading.value = true
    try {
      const res = await getStatisticsOverviewApi()
      overview.value = res ?? null
      overviewError.value = ''
      statsUpdatedAt.value = formatTimeAxis(Date.now())
    } catch (error: unknown) {
      overviewError.value = getApiErrorMessage(error, '统计概览加载失败')
    } finally {
      overviewLoading.value = false
    }
  }

  async function loadHealth() {
    try {
      health.value = await getHealthApi()
    } catch {
      health.value = { status: 'unreachable', service: 'databridge-admin' }
    } finally {
      healthUpdatedAt.value = formatTimeAxis(Date.now())
    }
  }

  /** 标记告警已读：PATCH 成功后刷新 overview（recentAlerts 随统计接口一起回来） */
  async function handleMarkAlertRead(id: string) {
    try {
      await markAlertRecordReadApi(id)
      createMessage.success('已标记为已读')
      await loadOverview()
    } catch (error: unknown) {
      createMessage.error(getApiErrorMessage(error, '标记已读失败'))
    }
  }

  async function handleRefreshAll() {
    manualLoading.value = true
    try {
      await Promise.allSettled([loadHealth(), loadOverview()])
    } finally {
      manualLoading.value = false
    }
  }

  let statsTimer: IntervalHandle | null = null

  function clearTimers() {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
  }

  function syncTimers() {
    clearTimers()
    if (!unref(autoRefresh)) return
    statsTimer = setInterval(loadOverview, OVERVIEW_POLL_INTERVAL)
  }

  watch(autoRefresh, syncTimers)

  onMounted(async () => {
    await Promise.allSettled([loadHealth(), loadOverview()])
    syncTimers()
  })

  onUnmounted(clearTimers)
</script>

<style lang="less" scoped>
  .monitor-body {
    width: 100%;
  }

  .nav-list {
    margin: 0;
    padding: 0;
    list-style: none;

    &__item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 6px;
      border-bottom: 1px dashed #f0f0f0;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover {
        background-color: rgba(24, 144, 255, 0.06);
      }

      &:last-child {
        border-bottom: none;
      }
    }

    &__icon {
      flex: none;
      font-size: 18px;
    }

    &__main {
      flex: 1;
      min-width: 0;
    }

    &__title {
      font-weight: 600;
    }

    &__desc {
      overflow: hidden;
      color: #8c8c8c;
      font-size: 12px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    &__badge {
      flex: none;
    }

    &__arrow {
      flex: none;
      color: #bfbfbf;
      font-size: 12px;
    }
  }
</style>
