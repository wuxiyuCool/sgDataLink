<template>
  <PanelCard
    title="数据服务调用 TOP5"
    icon="ant-design:api-outlined"
    hint="来自 GET /statistics/overview 的 topDataApis：仅统计已发布（published）服务，按累计调用量降序取前 5"
    :loading="loading"
    :error="error"
    :skeleton-rows="5"
  >
    <template #extra>
      <Button type="link" size="small" @click="goList">数据服务管理</Button>
    </template>

    <Empty v-if="!items.length" :description="DASH_EMPTY_TEXT.dataApis" />
    <Table
      v-else
      :columns="topDataApiColumns"
      :data-source="items"
      :pagination="false"
      :scroll="{ x: 620 }"
      row-key="id"
      size="small"
      class="top-table"
      :custom-row="customRow"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <span class="api-name">{{ record.name }}</span>
        </template>
        <template v-else-if="column.key === 'path'">
          <Tooltip :title="`运行时端点：GET /ds/${record.path}`">
            <span class="mono">/ds/{{ record.path }}</span>
          </Tooltip>
        </template>
        <template v-else-if="column.key === 'invokeCount'">
          <!-- 条形背景按占 TOP1 的比例渲染，纯 CSS，不额外引图表 -->
          <div class="invoke">
            <span class="invoke__bar" :style="{ width: barWidth(record.invokeCount) }"></span>
            <span class="invoke__text">{{ formatNumber(record.invokeCount) }}</span>
          </div>
        </template>
        <template v-else-if="column.key === 'errorCount'">
          <span :class="Number(record.errorCount) > 0 ? 'invoke__error' : 'invoke__ok'">
            {{ formatNumber(record.errorCount) }}
          </span>
        </template>
        <template v-else-if="column.key === 'avgLatencyMs'">
          {{ formatLatency(record.avgLatencyMs) }}
        </template>
      </template>
    </Table>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { useRouter } from 'vue-router'
  import { Button, Empty, Table, Tooltip } from 'ant-design-vue'
  import { formatNumber } from '/@/views/databridge/data'
  import type { TopDataApiItem } from '/@/api/databridge/statistics'
  import { DASH_EMPTY_TEXT, topDataApiColumns } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    items: { type: Array as PropType<TopDataApiItem[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const router = useRouter()

  const maxInvoke = computed(() =>
    (props.items || []).reduce((max, item) => Math.max(max, Number(item.invokeCount) || 0), 0),
  )

  function barWidth(value?: number) {
    if (!maxInvoke.value) return '0%'
    const ratio = Math.max(Number(value) || 0, 0) / maxInvoke.value
    // 最小给 4% 宽度，避免调用量为 1 的服务看不到色条
    return `${Math.max(Math.round(ratio * 100), value ? 4 : 0)}%`
  }

  function formatLatency(value?: number) {
    const ms = Number(value) || 0
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(ms < 10 ? 2 : 0)} ms`
  }

  /** 每一行都跳数据服务管理页（大盘只做导流，不带行内详情） */
  function customRow() {
    return {
      onClick: () => router.push('/databridge/dataapi'),
      style: { cursor: 'pointer' },
    }
  }

  function goList() {
    router.push('/databridge/dataapi')
  }
</script>

<style lang="less" scoped>
  .mono {
    font-family: monospace;
  }

  .api-name {
    font-weight: 500;
  }

  .invoke {
    position: relative;
    display: block;
    height: 18px;
    line-height: 18px;

    &__bar {
      position: absolute;
      top: 2px;
      right: auto;
      left: 0;
      height: 14px;
      background: linear-gradient(90deg, rgba(47, 84, 235, 0.12), rgba(47, 84, 235, 0.42));
      border-radius: 3px;
    }

    &__text {
      position: relative;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    &__error {
      color: #cf1322;
    }

    &__ok {
      color: #8c8c8c;
    }
  }

  .top-table {
    :deep(.ant-table-cell) {
      padding: 6px 8px;
    }
  }
</style>
