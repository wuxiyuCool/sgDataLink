<template>
  <PanelCard
    title="近 7 天执行趋势"
    icon="ant-design:bar-chart-outlined"
    hint="数据来自 GET /statistics/overview 的 recentTrend，按运行实例 startedAt 的 UTC 日期聚合（柱=成功/失败，折线=当日执行总数）"
    :loading="loading"
    :error="error"
    :skeleton-rows="5"
  >
    <template #extra>
      <span class="trend-summary">
        <span class="trend-summary__ok">成功 {{ week.success }}</span>
        <span class="trend-summary__bad">失败 {{ week.failed }}</span>
      </span>
    </template>
    <Empty v-if="!hasData" :description="DASH_EMPTY_TEXT.trend" />
    <div v-show="hasData" ref="chartRef" :style="{ width: '100%', height: '262px' }"></div>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref, watch } from 'vue'
  import type { PropType, Ref } from 'vue'
  import { Empty } from 'ant-design-vue'
  import { useECharts } from '/@/hooks/web/useECharts'
  import type { StatisticsTrendItem } from '/@/api/databridge/statistics'
  import { DASH_COLORS, DASH_EMPTY_TEXT, sumTrend } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    trend: { type: Array as PropType<StatisticsTrendItem[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const week = computed(() => sumTrend(props.trend))
  const hasData = computed(() => (props.trend || []).length > 0)

  /** 坐标轴只留 MM-DD，7 个刻度在小屏也不会挤成两行 */
  function axisLabel(date: string) {
    return String(date || '').slice(5)
  }

  function renderChart(full = false) {
    const list = props.trend || []
    if (!list.length) return
    setOptions({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['成功', '失败', '执行总数'], top: 0, itemWidth: 10, itemHeight: 8 },
      grid: { left: '1%', right: '2%', top: 42, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: list.map((item) => axisLabel(item.date)) },
      yAxis: { type: 'value', name: '实例数', minInterval: 1 },
      series: [
        {
          name: '成功',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: DASH_COLORS.success, borderRadius: [3, 3, 0, 0] },
          data: list.map((item) => Number(item.success || 0)),
        },
        {
          name: '失败',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: DASH_COLORS.failed, borderRadius: [3, 3, 0, 0] },
          data: list.map((item) => Number(item.failed || 0)),
        },
        {
          name: '执行总数',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: DASH_COLORS.running },
          lineStyle: { width: 2 },
          data: list.map((item) => Number(item.success || 0) + Number(item.failed || 0)),
        },
      ],
    }, full)
  }

  watch(
    () => props.trend,
    () => renderChart(),
    { deep: true, immediate: true },
  )
</script>

<style lang="less" scoped>
  .trend-summary {
    display: inline-flex;
    gap: 10px;
    font-size: 12px;

    &__ok {
      color: #52c41a;
    }

    &__bad {
      color: #ff4d4f;
    }
  }
</style>
