<template>
  <PanelCard
    title="所选实例进度曲线"
    icon="ant-design:line-chart-outlined"
    hint="曲线来自前端本地采样：每 3 秒读取一次运行实例与进度接口，仅保留最近 60 个点（约 3 分钟），不落库"
    :skeleton="false"
  >
    <template #extra>
      <Space :size="8">
        <span class="trace-label">{{ label || '未选择实例' }}</span>
        <Tag v-if="samples.length">{{ samples.length }} 个采样点</Tag>
        <Button size="small" :disabled="!samples.length" @click="emit('clear')">
          <Icon icon="ant-design:clear-outlined" class="mr-1" />
          清空采样点
        </Button>
      </Space>
    </template>

    <Empty v-if="!samples.length" :description="emptyDescription" />
    <div v-show="samples.length" ref="chartRef" :style="{ width: '100%', height: '280px' }"></div>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref, watch } from 'vue'
  import type { PropType, Ref } from 'vue'
  import { Button, Empty, Space, Tag } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { DASH_COLORS, MAX_PROGRESS_SAMPLES } from '../monitor.data'
  import type { ProgressSample } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    samples: { type: Array as PropType<ProgressSample[]>, default: () => [] },
    /** 追踪对象的可读名称（任务名 · 实例 ID） */
    label: { type: String, default: '' },
  })

  const emit = defineEmits(['clear'])

  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const emptyDescription = computed(
    () => `等待采样点（每 3 秒一次，最多 ${MAX_PROGRESS_SAMPLES} 个点）`,
  )

  function renderChart(full = false) {
    const points = props.samples || []
    if (!points.length) return
    const timeOf = (item: ProgressSample) => item.time
    setOptions({
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['进度(%)', '已读行数', '已写行数', '速率(rows/s)'],
        top: 0,
        itemWidth: 10,
        itemHeight: 8,
      },
      grid: { left: '1%', right: '2%', top: 44, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map(timeOf),
      },
      yAxis: [
        { type: 'value', name: '进度 %', max: 100 },
        { type: 'value', name: '行数 / 速率', minInterval: 1 },
      ],
      series: [
        {
          name: '进度(%)',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          yAxisIndex: 0,
          itemStyle: { color: DASH_COLORS.running },
          areaStyle: { opacity: 0.12 },
          data: points.map((item) => Number(item.progress || 0)),
        },
        {
          name: '已读行数',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: DASH_COLORS.service },
          data: points.map((item) => Number(item.readRows || 0)),
        },
        {
          name: '已写行数',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: DASH_COLORS.pipeline },
          data: points.map((item) => Number(item.writeRows || 0)),
        },
        {
          name: '速率(rows/s)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          lineStyle: { type: 'dashed' },
          itemStyle: { color: DASH_COLORS.warning },
          data: points.map((item) => Number(item.rate || 0)),
        },
      ],
    }, full)
  }

  // 新增采样点：merge 局部更新（不清图、不重放入场动画）
  watch(
    () => props.samples,
    () => renderChart(),
    { deep: true, immediate: true },
  )

  // 切换追踪实例属于结构级变化：整图重画一次，避免旧曲线向新数据做补间变形
  watch(
    () => props.label,
    () => renderChart(true),
  )
</script>

<style lang="less" scoped>
  .trace-label {
    color: #8c8c8c;
    font-size: 12px;
  }
</style>
