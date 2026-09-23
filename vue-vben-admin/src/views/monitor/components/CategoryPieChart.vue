<template>
  <PanelCard
    :title="title"
    :icon="icon"
    :hint="hint"
    :loading="loading"
    :error="error"
    :skeleton-rows="skeletonRows"
  >
    <template #extra>
      <slot name="extra"></slot>
    </template>
    <Empty v-if="!hasData" :description="emptyText" />
    <div class="chart-wrap">
      <div v-show="hasData" ref="chartRef" :style="{ width: '100%', height: props.height }"></div>
      <!-- 环形图中心文字：DOM 覆盖而不是 ECharts title，暗色主题下同样清晰 -->
      <div v-if="donut && hasData" class="chart-center">
        <div class="chart-center__value" :style="{ color: centerColor }">{{ centerValue }}</div>
        <div class="chart-center__label">{{ centerLabel }}</div>
      </div>
    </div>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref, unref, watch } from 'vue'
  import type { PropType, Ref } from 'vue'
  import { Empty } from 'ant-design-vue'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { CHART_PALETTE, DASH_COLORS } from '../monitor.data'
  import type { ChartDatum } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    title: { type: String, required: true },
    data: { type: Array as PropType<ChartDatum[]>, default: () => [] },
    icon: { type: String, default: 'ant-design:pie-chart-outlined' },
    hint: { type: String, default: '' },
    /** true = 环形（中心显示总数），false = 实心饼图 */
    donut: { type: Boolean, default: false },
    centerValue: { type: [String, Number], default: '' },
    centerLabel: { type: String, default: '总数' },
    centerColor: { type: String, default: DASH_COLORS.running },
    height: { type: String, default: '250px' },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    emptyText: { type: String, default: '暂无分布数据' },
    skeletonRows: { type: Number, default: 5 },
  })

  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const hasData = computed(() => (props.data || []).some((item) => Number(item.value) > 0))

  function renderChart(full = false) {
    const list = (props.data || []).filter((item) => Number(item.value) > 0)
    if (!list.length) return
    const valueOf = (name: string) => list.find((item) => item.name === name)?.value ?? 0
    setOptions({
      tooltip: {
        trigger: 'item',
        formatter: '{b}：{c} 个（{d}%）',
      },
      legend: {
        orient: 'vertical',
        right: 4,
        top: 'center',
        itemWidth: 8,
        itemHeight: 8,
        icon: 'circle',
        formatter: (name: string) => `${name}  ${valueOf(name)}`,
      },
      series: [
        {
          name: props.title,
          type: 'pie',
          radius: props.donut ? ['52%', '72%'] : '68%',
          center: ['35%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: {
            borderColor: '#fff',
            borderWidth: 2,
          },
          // 环形图强调中心总数，实心饼图直接带出类别名，读图路径更短
          label: { show: !props.donut, formatter: '{b}' },
          labelLine: { show: !props.donut, length: 8, length2: 8 },
          emphasis: { scale: true, scaleSize: 6 },
          data: list.map((item, index) => ({
            name: item.name,
            value: Number(item.value) || 0,
            itemStyle: { color: item.color || CHART_PALETTE[index % CHART_PALETTE.length] },
          })),
        },
      ],
    }, full)
  }

  watch(
    () => [props.data, hasData.value],
    () => {
      if (unref(hasData)) renderChart()
    },
    { deep: true, immediate: true },
  )
</script>

<style lang="less" scoped>
  .chart-wrap {
    position: relative;
    width: 100%;
  }

  /* left 与 ECharts 的 center: ['35%', '50%'] 对齐 */
  .chart-center {
    position: absolute;
    top: 50%;
    left: 35%;
    pointer-events: none;
    text-align: center;
    transform: translate(-50%, -50%);

    &__value {
      font-size: 22px;
      font-weight: 600;
      line-height: 28px;
    }

    &__label {
      color: #8c8c8c;
      font-size: 12px;
    }
  }
</style>
