<template>
  <PanelCard
    title="近 7 日成功 / 错误调用"
    icon="ant-design:bar-chart-outlined"
    hint="数据来自 GET /statistics/overview 的 dataApiCallStats.dayTrend（按调用明细日志按日聚合，契约 1.5）；柱为堆叠的成功/错误次数，折线为当日总调用量"
    :loading="loading"
    :error="error"
    :skeleton-rows="5"
  >
    <template #extra>
      <span class="summary">
        <span class="summary__ok">成功 {{ week.success }}</span>
        <span class="summary__bad">错误 {{ week.error }}</span>
      </span>
    </template>
    <Empty v-if="!hasData" :description="DASH_EMPTY_TEXT.calls" />
    <div v-show="hasData" ref="chartRef" :style="{ width: '100%', height: '262px' }"></div>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref, unref, watch } from 'vue'
  import type { PropType, Ref } from 'vue'
  import { Empty } from 'ant-design-vue'
  import { useECharts } from '/@/hooks/web/useECharts'
  import type { DataApiCallTrendItem } from '/@/api/databridge/statistics'
  import { DASH_COLORS, DASH_EMPTY_TEXT } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    trend: { type: Array as PropType<DataApiCallTrendItem[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const week = computed(() =>
    (props.trend || []).reduce(
      (acc, item) => ({
        success: acc.success + Number(item.success || 0),
        error: acc.error + Number(item.error || 0),
      }),
      { success: 0, error: 0 },
    ),
  )

  /** 只有「有调用记录」才画图，全 0 的 7 天空桶交给 Empty 说明 */
  const hasData = computed(() =>
    (props.trend || []).some((item) => Number(item.success) > 0 || Number(item.error) > 0),
  )

  function axisLabel(date: string) {
    return String(date || '').slice(5)
  }

  function renderChart() {
    const list = props.trend || []
    if (!list.length) return
    setOptions({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['成功', '错误', '调用总量'], top: 0, itemWidth: 10, itemHeight: 8 },
      grid: { left: '1%', right: '2%', top: 42, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: list.map((item) => axisLabel(item.date)) },
      yAxis: { type: 'value', name: '调用次数', minInterval: 1 },
      series: [
        {
          name: '成功',
          type: 'bar',
          stack: 'calls',
          barMaxWidth: 18,
          itemStyle: { color: DASH_COLORS.success, borderRadius: [0, 0, 3, 3] },
          data: list.map((item) => Number(item.success || 0)),
        },
        {
          name: '错误',
          type: 'bar',
          stack: 'calls',
          barMaxWidth: 18,
          itemStyle: { color: DASH_COLORS.failed, borderRadius: [3, 3, 0, 0] },
          data: list.map((item) => Number(item.error || 0)),
        },
        {
          name: '调用总量',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          itemStyle: { color: DASH_COLORS.service },
          lineStyle: { width: 2 },
          data: list.map((item) => Number(item.success || 0) + Number(item.error || 0)),
        },
      ],
    })
  }

  watch(
    () => [props.trend, unref(hasData)],
    () => {
      if (unref(hasData)) renderChart()
    },
    { deep: true, immediate: true },
  )
</script>

<style lang="less" scoped>
  .summary {
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
