<template>
  <Drawer
    :visible="visible"
    :width="640"
    :title="`调用统计 · ${api?.name || ''}`"
    placement="right"
    @close="handleClose"
  >
    <div class="mb-3 flex items-center justify-between">
      <span class="text-gray-500">数据来自 GET /data-apis/:id/stats</span>
      <Button size="small" :loading="loading" @click="loadStats">
        <Icon icon="ant-design:reload-outlined" class="mr-1" />
        刷新
      </Button>
    </div>

    <Row :gutter="[12, 12]" class="mb-3">
      <Col v-for="item in cards" :key="item.title" :span="8">
        <Card :bordered="false" size="small" :loading="loading">
          <Statistic :title="item.title" :value="item.value" :value-style="item.style">
            <template #prefix>
              <Icon :icon="item.icon" />
            </template>
          </Statistic>
          <div class="card-hint">{{ item.hint }}</div>
        </Card>
      </Col>
    </Row>

    <Card :bordered="false" size="small" title="最近 7 天调用趋势">
      <Empty v-if="!trend.length && !loading" description="暂无趋势数据（后端未返回 recentTrend）" />
      <div v-show="trend.length" ref="chartRef" :style="{ width: '100%', height: '300px' }"></div>
    </Card>
  </Drawer>
</template>
<script lang="ts" setup>
  import { computed, ref, unref, watch } from 'vue'
  import type { Ref } from 'vue'
  import { Button, Card, Col, Drawer, Empty, Row, Statistic } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { getDataApiStatsApi } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    DataApi,
    DataApiStats,
    DataApiTrendItem,
  } from '/@/api/databridge/model/dataapiModel'
  import { getTrendCount, getTrendErrorCount } from './dataapi.data'

  const props = defineProps({
    visible: { type: Boolean, default: false },
    api: { type: Object as () => DataApi | null, default: null },
  })

  const emit = defineEmits(['update:visible'])

  const { createMessage } = useMessage()
  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)

  const loading = ref(false)
  const stats = ref<DataApiStats | null>(null)
  const trend = ref<DataApiTrendItem[]>([])

  const cards = computed(() => [
    {
      title: '调用次数',
      value: Number(stats.value?.invokeCount ?? props.api?.invokeCount ?? 0),
      icon: 'ant-design:api-outlined',
      style: { color: '#1890ff' },
      hint: '含管理端调试代理的调用',
    },
    {
      title: '错误次数',
      value: Number(stats.value?.errorCount ?? props.api?.errorCount ?? 0),
      icon: 'ant-design:warning-outlined',
      style: { color: '#f5222d' },
      hint: '鉴权失败 / IP 白名单 / 超限流均计入',
    },
    {
      title: '平均延迟',
      value: Number(stats.value?.avgLatencyMs ?? props.api?.avgLatencyMs ?? 0),
      icon: 'ant-design:field-time-outlined',
      style: { color: '#52c41a' },
      hint: '毫秒',
    },
  ])

  async function loadStats() {
    const id = props.api?.id
    if (!id) return
    loading.value = true
    try {
      const res = await getDataApiStatsApi(id)
      stats.value = {
        invokeCount: Number(res?.invokeCount ?? 0),
        errorCount: Number(res?.errorCount ?? 0),
        avgLatencyMs: Number(res?.avgLatencyMs ?? 0),
      }
      trend.value = res?.recentTrend ?? []
      renderChart()
    } catch (error: any) {
      trend.value = []
      createMessage.error(getApiErrorMessage(error, '统计加载失败'))
    } finally {
      loading.value = false
    }
  }

  /** 柱状（调用/错误）+ 折线（平均延迟）组合图 */
  function renderChart() {
    const list = unref(trend)
    if (!list.length) return
    setOptions({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['调用次数', '错误次数', '平均延迟(ms)'] },
      grid: { left: '1%', right: '1%', top: 50, bottom: 24, containLabel: true },
      xAxis: { type: 'category', data: list.map((item) => item.date) },
      yAxis: [
        { type: 'value', name: '次数', minInterval: 1 },
        { type: 'value', name: '延迟 ms', minInterval: 1 },
      ],
      series: [
        {
          name: '调用次数',
          type: 'bar',
          barMaxWidth: 26,
          itemStyle: { color: '#1890ff' },
          data: list.map((item) => getTrendCount(item)),
        },
        {
          name: '错误次数',
          type: 'bar',
          barMaxWidth: 26,
          itemStyle: { color: '#f5222d' },
          data: list.map((item) => getTrendErrorCount(item)),
        },
        {
          name: '平均延迟(ms)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#faad14' },
          data: list.map((item) => Number(item.avgLatencyMs ?? 0)),
        },
      ],
    })
  }

  watch(
    () => [props.visible, props.api?.id],
    () => {
      if (props.visible) loadStats()
    },
  )

  function handleClose() {
    emit('update:visible', false)
  }
</script>
<style lang="less" scoped>
  .card-hint {
    margin-top: 4px;
    color: #8c8c8c;
    font-size: 12px;
  }
</style>
