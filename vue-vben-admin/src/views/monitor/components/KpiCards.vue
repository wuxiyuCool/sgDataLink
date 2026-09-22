<template>
  <Alert
    v-if="error"
    class="mb-3"
    type="error"
    show-icon
    closable
    message="统计概览加载失败"
    :description="error"
    @close="emit('dismissError')"
  />
  <Row v-else :gutter="[16, 16]">
    <Col v-for="card in cards" :key="card.key" :xs="12" :sm="12" :md="8" :lg="4" :xl="4">
      <Card :bordered="false" size="small" class="kpi-card">
        <Skeleton
          v-if="loading && !overview"
          active
          :paragraph="{ rows: 2 }"
          :title="{ width: 90 }"
        />
        <template v-else>
          <div class="kpi-head">
            <Icon :icon="card.icon" :color="card.color" class="kpi-head__icon" />
            <Tooltip v-if="card.tip" :title="card.tip">
              <span class="kpi-head__title">{{ card.title }}</span>
            </Tooltip>
            <span v-else class="kpi-head__title">{{ card.title }}</span>
          </div>
          <div class="kpi-value" :style="{ color: card.color }">
            {{ card.value }}
            <span v-if="card.suffix" class="kpi-value__suffix">{{ card.suffix }}</span>
          </div>
          <div class="kpi-sub">
            <template v-if="card.sub.length">
              <span
                v-for="(seg, index) in card.sub"
                :key="index"
                :style="seg.color ? { color: seg.color } : {}"
              >
                {{ seg.text }}{{ index === card.sub.length - 1 ? '' : ' ' }}
              </span>
            </template>
            <span v-else class="kpi-sub__empty">—</span>
          </div>
          <Progress
            v-if="card.bar !== undefined"
            class="kpi-bar"
            size="small"
            :percent="card.bar"
            :show-info="false"
            :stroke-color="card.color"
          />
        </template>
      </Card>
    </Col>
  </Row>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { Alert, Card, Col, Progress, Row, Skeleton, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { formatLag, getDatasourceTypeLabel } from '/@/views/databridge/data'
  import type { StatisticsOverview } from '/@/api/databridge/statistics'
  import {
    DASH_COLORS,
    DATASOURCE_TYPE_CHART_COLORS,
    successRateColor,
    sumTrend,
  } from '../monitor.data'

  interface Segment {
    text: string
    color?: string
  }

  interface KpiCard {
    key: string
    title: string
    value: string | number
    suffix?: string
    icon: string
    color: string
    /** 标题悬浮提示（分类型 / 已发布数等细分口径） */
    tip?: string
    /** 副标题：分段文本，可自带语义色 */
    sub: Segment[]
    /** 传入 0-100 时渲染一条细进度条（成功率卡用） */
    bar?: number
  }

  const props = defineProps({
    overview: { type: Object as PropType<StatisticsOverview | null>, default: null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const emit = defineEmits(['dismissError'])

  const KPI_ICONS = {
    datasource: 'ant-design:database-outlined',
    task: 'ant-design:partition-outlined',
    running: 'ant-design:sync-outlined',
    today: 'ant-design:field-time-outlined',
    rate: 'ant-design:dashboard-outlined',
    dataApi: 'ant-design:api-outlined',
  }

  /** 空态兜底（接口未回来时卡片仍按 0 渲染，避免出现 NaN） */
  const data = computed(() => props.overview)

  function modeCount(mode: 'cdc' | 'dataflow') {
    const item = (data.value?.taskModeDistribution ?? []).find((row) => row.mode === mode)
    return Number(item?.count ?? 0)
  }

  /** 数据源分类型明细，同时用作 tooltip 与副标题 */
  function datasourceTypeSegments() {
    return (data.value?.datasourceTypes ?? [])
      .filter((item) => Number(item.count) > 0)
      .map((item) => ({
        text: `${getDatasourceTypeLabel(item.type)} ${item.count}`,
        color: DATASOURCE_TYPE_CHART_COLORS[item.type],
      }))
  }

  /** 今日 vs 昨日（recentTrend 倒数第 2 桶）的环比文案 */
  function dayOverDaySegments() {
    const trend = data.value?.recentTrend ?? []
    if (trend.length < 2) return []
    const yesterday = trend[trend.length - 2]
    const yesterdayTotal = Number(yesterday.success || 0) + Number(yesterday.failed || 0)
    const todayTotal = Number(data.value?.todayTotal ?? 0)
    const diff = todayTotal - yesterdayTotal
    const label =
      diff > 0 ? `较昨日 +${diff}` : diff < 0 ? `较昨日 -${Math.abs(diff)}` : '与昨日持平'
    return [
      { text: `成功 ${data.value?.todaySuccess ?? 0}`, color: DASH_COLORS.success },
      { text: `失败 ${data.value?.todayFailed ?? 0}`, color: DASH_COLORS.failed },
      { text: `停止 ${data.value?.todayStopped ?? 0}`, color: DASH_COLORS.warning },
      { text: label },
    ]
  }

  const cards = computed<KpiCard[]>(() => {
    const overview = data.value
    if (!overview) return []
    const runningPipelines = overview.runningPipelines ?? { count: 0, maxLagMs: null }
    const runningTotal = Number(overview.todayRunning ?? overview.runningInstances ?? 0)
    const batchRunning = Math.max(runningTotal - runningPipelines.count, 0)
    const week = sumTrend(overview.recentTrend)
    const weekTotal = week.success + week.failed
    const rate = overview.weekSuccessRate
    const rateColor = successRateColor(rate)
    const draftApis = Math.max((overview.dataApiTotal ?? 0) - (overview.publishedDataApis ?? 0), 0)
    const types = datasourceTypeSegments()

    return [
      {
        key: 'datasource',
        title: '数据源',
        value: overview.datasourceTotal ?? 0,
        icon: KPI_ICONS.datasource,
        color: DASH_COLORS.pipeline,
        tip: types.length
          ? `类型分布：${types.map((item) => item.text).join(' · ')}`
          : '暂无数据源',
        sub: types,
      },
      {
        key: 'task',
        title: '同步任务',
        value: overview.taskTotal ?? 0,
        icon: KPI_ICONS.task,
        color: DASH_COLORS.running,
        tip: '口径：同步任务数；数据管道与数据开发分别独立统计',
        sub: [
          { text: `管道 ${modeCount('cdc')}`, color: DASH_COLORS.pipeline },
          { text: `数据开发 ${modeCount('dataflow')}`, color: DASH_COLORS.warning },
        ],
      },
      {
        key: 'running',
        title: '运行中实例',
        value: runningTotal,
        icon: KPI_ICONS.running,
        color: DASH_COLORS.service,
        tip: '含数据管道实例；管道延迟取所有运行管道的最大值',
        sub: [
          { text: `任务/画布 ${batchRunning}`, color: DASH_COLORS.running },
          { text: `管道 ${runningPipelines.count}`, color: DASH_COLORS.pipeline },
          {
            text: `最大延迟 ${formatLag(runningPipelines.maxLagMs)}`,
            color: DASH_COLORS.neutral,
          },
        ],
      },
      {
        key: 'today',
        title: '今日执行',
        value: overview.todayTotal ?? 0,
        icon: KPI_ICONS.today,
        color: DASH_COLORS.warning,
        tip: '按实例 startedAt 的 UTC 日期归入「今日」',
        sub: dayOverDaySegments(),
      },
      {
        key: 'rate',
        title: '7 日成功率',
        value: rate === null || rate === undefined ? '-' : Number(rate).toFixed(1),
        suffix: rate === null || rate === undefined ? '' : '%',
        icon: KPI_ICONS.rate,
        color: rateColor,
        tip: '口径：近 7 天 success / (success + failed)',
        bar:
          rate === null || rate === undefined
            ? undefined
            : Math.min(Math.max(Number(rate), 0), 100),
        sub: weekTotal
          ? [
              { text: `成功 ${week.success}`, color: DASH_COLORS.success },
              { text: `失败 ${week.failed}`, color: DASH_COLORS.failed },
            ]
          : [{ text: '近 7 天无终态实例' }],
      },
      {
        key: 'dataApi',
        title: '数据服务',
        value: overview.dataApiTotal ?? 0,
        icon: KPI_ICONS.dataApi,
        color: '#2f54eb',
        tip: `已发布 ${overview.publishedDataApis ?? 0} 个 · 草稿 ${draftApis} 个`,
        sub: [
          { text: `已发布 ${overview.publishedDataApis ?? 0}`, color: DASH_COLORS.success },
          { text: `草稿 ${draftApis}`, color: DASH_COLORS.neutral },
        ],
      },
    ]
  })
</script>

<style lang="less" scoped>
  .kpi-card {
    position: relative;
    overflow: hidden;
    transition: box-shadow 0.2s;

    &:hover {
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.09);
    }
  }

  .kpi-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #8c8c8c;
    font-size: 13px;

    &__icon {
      font-size: 15px;
    }

    &__title {
      cursor: default;
    }
  }

  .kpi-value {
    margin-top: 2px;
    font-size: 26px;
    font-weight: 600;
    line-height: 34px;

    &__suffix {
      font-size: 14px;
      font-weight: 400;
    }
  }

  .kpi-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    min-height: 20px;
    color: #8c8c8c;
    font-size: 12px;
    line-height: 20px;

    &__empty {
      color: #bfbfbf;
    }
  }

  .kpi-bar {
    margin-top: 2px;
  }
</style>
