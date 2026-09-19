<template>
  <PageWrapper
    title="数据血缘"
    content="GET /lineage/graph 由数据源 + 同步任务 + 数据管道 + 数据开发 + 数据服务聚合生成的表级血缘；连线箭头方向即数据流向（source → target）"
  >
    <Card :bordered="false" class="mb-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <Space wrap>
          <span class="text-gray-500">{{ summary }}</span>
          <Tag v-if="duplicatedNames" color="orange">
            存在 {{ duplicatedNames }} 组同名表，已按 id 区分展示
          </Tag>
        </Space>
        <Space>
          <span class="text-gray-500">布局</span>
          <RadioGroup
            v-model:value="layout"
            size="small"
            :options="[
              { label: '力导向', value: 'force' },
              { label: '环形', value: 'circular' },
            ]"
            @change="renderChart"
          />
          <Button :loading="loading" @click="loadGraph">
            <Icon icon="ant-design:reload-outlined" class="mr-1" />
            刷新血缘
          </Button>
        </Space>
      </div>
    </Card>

    <Card :bordered="false" title="血缘图">
      <Empty v-if="!nodes.length && !loading" description="暂无血缘数据（后端 /lineage/graph 未返回节点）" />
      <div v-show="nodes.length" ref="chartRef" :style="{ width: '100%', height: '620px' }"></div>
    </Card>

    <Card :bordered="false" class="mt-3" title="选中节点">
      <Descriptions v-if="selectedNode" :column="3" size="small">
        <DescriptionsItem label="名称">{{ selectedNode.rawName }}</DescriptionsItem>
        <DescriptionsItem label="类型">
          <Tag :color="getLineageNodeColor(selectedNode.type)">
            {{ getLineageNodeLabel(selectedNode.type) }}
          </Tag>
        </DescriptionsItem>
        <DescriptionsItem label="节点 ID">
          <span class="mono">{{ selectedNode.id }}</span>
        </DescriptionsItem>
        <DescriptionsItem label="上游" :span="3">
          {{ getRelatedText('in') || '无' }}
        </DescriptionsItem>
        <DescriptionsItem label="下游" :span="3">
          {{ getRelatedText('out') || '无' }}
        </DescriptionsItem>
      </Descriptions>
      <span v-else class="text-gray-500">点击图中任意节点查看上下游链路</span>
    </Card>
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { computed, nextTick, onMounted, ref, unref } from 'vue'
  import type { Ref } from 'vue'
  import { Button, Card, Descriptions, Empty, Radio, Space, Tag } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { getLineageGraphApi } from '/@/api/databridge/lineage'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    LineageEdge,
    LineageGraph,
    LineageNode,
  } from '/@/api/databridge/model/lineageModel'
  import { getLineageNodeColor, getLineageNodeLabel } from '../data'
  import { buildLineageChartData, getLineageSummary } from './lineage.data'

  const RadioGroup = Radio.Group
  const DescriptionsItem = Descriptions.Item

  const { createMessage } = useMessage()
  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions, getInstance } = useECharts(chartRef as Ref<HTMLDivElement>)

  const loading = ref(false)
  const layout = ref<'force' | 'circular'>('force')
  const nodes = ref<LineageNode[]>([])
  const edges = ref<LineageEdge[]>([])
  const selectedNode = ref<(LineageNode & { rawName?: string; name?: string }) | null>(null)
  /** id → 图上展示名（含同名去重后缀），用于选中面板的上下游文案 */
  const nameById = ref<Record<string, string>>({})

  const summary = computed(() =>
    getLineageSummary({ nodes: unref(nodes), edges: unref(edges) } as LineageGraph),
  )

  const duplicatedNames = ref(0)

  async function loadGraph() {
    loading.value = true
    try {
      const graph = await getLineageGraphApi()
      nodes.value = graph?.nodes ?? []
      edges.value = graph?.edges ?? []
      selectedNode.value = null
      await nextTick()
      renderChart()
    } catch (error: any) {
      nodes.value = []
      edges.value = []
      createMessage.error(getApiErrorMessage(error, '血缘数据加载失败'))
    } finally {
      loading.value = false
    }
  }

  function renderChart() {
    if (!unref(nodes).length) return
    const chart = buildLineageChartData({
      nodes: unref(nodes),
      edges: unref(edges),
    } as LineageGraph)
    const map: Record<string, string> = {}
    chart.nodes.forEach((item) => {
      map[item.id] = item.rawName
    })
    nameById.value = map
    duplicatedNames.value = chart.duplicatedNames

    setOptions({
      tooltip: { trigger: 'item' },
      legend: [
        {
          data: chart.categories.map((item) => item.name),
          top: 8,
          icon: 'circle',
        },
      ],
      animationDuration: 600,
      series: [
        {
          type: 'graph',
          layout: unref(layout),
          roam: true,
          draggable: true,
          categories: chart.categories,
          data: chart.nodes,
          // ECharts 5 起 edges 与 links 等价，这里用兼容性更好的 links
          links: chart.edges,
          label: {
            show: true,
            position: 'right',
            formatter: (params: any) => params?.data?.rawName ?? params?.name ?? '',
            fontSize: 12,
          },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 9,
          lineStyle: { color: '#bfbfbf', width: 1.2, curveness: 0.12, opacity: 0.9 },
          emphasis: { focus: 'adjacency', lineStyle: { width: 2.4, color: '#1890ff' } },
          circular: { rotateLabel: true },
          force: {
            initLayout: 'circular',
            repulsion: 260,
            edgeLength: [90, 180],
            gravity: 0.05,
            layoutAnimation: true,
          },
        },
      ],
    })
    bindChartEvents()
  }

  /** 节点点击：ECharts 的 tooltip 只在 hover 时出现，这里补一个选中态展示上下游 */
  function bindChartEvents() {
    nextTick(() => {
      try {
        const instance = getInstance()
        if (!instance || typeof instance.on !== 'function') return
        instance.off?.('click')
        instance.on('click', (params: any) => {
          if (params?.dataType !== 'node') return
          const data = params?.data ?? {}
          const node = unref(nodes).find((item) => item.id === data.id)
          if (!node) return
          selectedNode.value = { ...node, rawName: data.rawName ?? node.name, name: data.name }
        })
      } catch {
        // 图表实例尚未就绪时忽略，下一次渲染会再绑定
      }
    })
  }

  function getRelatedText(direction: 'in' | 'out') {
    const id = unref(selectedNode)?.id
    if (!id) return ''
    const names = unref(edges)
      .filter((edge) => (direction === 'in' ? edge.target === id : edge.source === id))
      .map((edge) => nameById.value[direction === 'in' ? edge.source : edge.target] || '')
      .filter(Boolean)
    return Array.from(new Set(names)).join('、')
  }

  onMounted(() => {
    loadGraph()
  })
</script>
<style lang="less" scoped>
  .mono {
    font-family: monospace;
  }
</style>
