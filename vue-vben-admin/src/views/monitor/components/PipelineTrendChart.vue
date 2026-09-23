<template>
  <PanelCard
    :title="`QPS / 延迟采样曲线（最近 ${PIPELINE_SAMPLE_WINDOW} 个点）`"
    icon="ant-design:line-chart-outlined"
    hint="双 Y 轴：左轴为 currentQps，右轴为 lagMs。数据来自前端本地采样——每 3 秒读取一次 GET /pipelines/:id/status 后追加一个点，仅保留最近 60 点（约 3 分钟），不落库、切换管道即清空"
    :loading="loading"
    :error="error"
    :skeleton="false"
  >
    <template #extra>
      <Space :size="8">
        <span class="chart-hint">{{ label || '未选择管道' }}</span>
        <Tag v-if="samples.length">{{ samples.length }} 个采样点</Tag>
        <Button size="small" :disabled="!samples.length" @click="emit('clear')">
          <Icon icon="ant-design:clear-outlined" class="mr-1" />
          清空采样点
        </Button>
      </Space>
    </template>

    <Empty v-if="!hasData" :description="emptyDescription" />
    <div v-show="hasData" ref="chartRef" :style="{ width: '100%', height: '300px' }"></div>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref, unref, watch } from 'vue'
  import type { PropType, Ref } from 'vue'
  import { Button, Empty, Space, Tag } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { LAG_THRESHOLD_MS } from '/@/views/databridge/data'
  import { DASH_COLORS, PIPELINE_SAMPLE_WINDOW } from '../monitor.data'
  import type { PipelineSample } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    samples: { type: Array as PropType<PipelineSample[]>, default: () => [] },
    /** 当前追踪的管道名 */
    label: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const emit = defineEmits(['clear'])

  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const hasData = computed(() => (props.samples || []).length > 0)
  const emptyDescription = computed(() =>
    props.label
      ? `等待采样点（运行中的管道每 3 秒一个点，最多 ${PIPELINE_SAMPLE_WINDOW} 个）`
      : '选择一条运行中的管道后开始采样',
  )

  function renderChart(full = false) {
    const points = props.samples || []
    if (!points.length) return
    setOptions({
      tooltip: { trigger: 'axis' },
      legend: { data: ['QPS', '同步延迟(ms)'], top: 0, itemWidth: 10, itemHeight: 8 },
      grid: { left: '1%', right: '2%', top: 46, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((item) => item.time),
      },
      yAxis: [
        { type: 'value', name: 'QPS', minInterval: 1 },
        { type: 'value', name: '延迟 ms', minInterval: 1 },
      ],
      series: [
        {
          name: 'QPS',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          yAxisIndex: 0,
          itemStyle: { color: DASH_COLORS.pipeline },
          areaStyle: { opacity: 0.12 },
          data: points.map((item) => Number(item.qps || 0)),
        },
        {
          name: '同步延迟(ms)',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          yAxisIndex: 1,
          itemStyle: { color: DASH_COLORS.warning },
          lineStyle: { width: 2 },
          data: points.map((item) => Number(item.lagMs || 0)),
          // 阈值线挂在右轴上，超线即代表会触发「延迟超阈值」告警
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', color: DASH_COLORS.failed },
            label: { formatter: `阈值 ${LAG_THRESHOLD_MS}ms`, position: 'insideEndTop' },
            data: [{ yAxis: LAG_THRESHOLD_MS }],
          },
        },
      ],
    }, full)
  }

  // 每次轮询父组件都会换一个新的数组引用，deep watch 保证新增采样点即刻重画
  watch(
    () => [props.samples, unref(hasData)],
    () => {
      if (unref(hasData)) renderChart()
    },
    { deep: true, immediate: true },
  )
</script>

<style lang="less" scoped>
  .chart-hint {
    color: #8c8c8c;
    font-size: 12px;
  }
</style>
