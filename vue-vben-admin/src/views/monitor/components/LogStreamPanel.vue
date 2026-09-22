<template>
  <PanelCard
    title="实时运行日志流"
    icon="ant-design:file-search-outlined"
    hint="来自 GET /statistics/overview 的 recentLogs（run_log 最新 15 条，契约 1.5）；默认每 10 秒拉取一次，可单独关闭；点击行跳转运行日志页按任务下钻"
    :loading="loading"
    :error="error"
    :skeleton-rows="6"
  >
    <template #extra>
      <Space :size="12">
        <RadioGroup
          v-model:value="level"
          size="small"
          button-style="solid"
          :options="levelOptions"
          option-type="button"
        />
        <span class="auto-hint">自动刷新(10s)</span>
        <Switch :checked="autoRefresh" size="small" @change="handleSwitchChange" />
      </Space>
    </template>

    <Empty
      v-if="!filtered.length"
      :description="
        logs.length ? `当前 ${logs.length} 条日志里没有 ${level} 级别` : DASH_EMPTY_TEXT.logs
      "
    />
    <Table
      v-else
      :columns="logStreamColumns"
      :data-source="filtered"
      :pagination="false"
      :scroll="{ x: 1080, y: scrollY }"
      row-key="id"
      size="small"
      :row-class-name="rowClassName"
      :custom-row="customRow"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">
          <span class="mono">{{ formatTime(record.createdAt) }}</span>
        </template>
        <template v-else-if="column.key === 'level'">
          <Tag :color="LOG_LEVEL_TAG_COLORS[record.level] || 'default'">{{ record.level }}</Tag>
        </template>
        <template v-else-if="column.key === 'taskName'">
          <Tooltip :title="`实例 ${record.instanceId || '-'}`">
            <span>{{ record.taskName || record.taskId || record.instanceId || '系统日志' }}</span>
          </Tooltip>
        </template>
        <template v-else-if="column.key === 'message'">
          <span class="log-message">{{ record.message || '-' }}</span>
        </template>
        <template v-else-if="column.key === 'instanceId'">
          <span class="mono">{{ record.instanceId || '-' }}</span>
        </template>
      </template>
    </Table>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'
  import type { PropType } from 'vue'
  import { useRouter } from 'vue-router'
  import { Empty, Radio, Space, Switch, Table, Tag, Tooltip } from 'ant-design-vue'
  import { formatTime, LOG_LEVEL_TAG_COLORS } from '/@/views/databridge/data'
  import type { LogLevel } from '/@/api/databridge/model/commonModel'
  import type { RecentLogItem } from '/@/api/databridge/statistics'
  import { DASH_EMPTY_TEXT, logStreamColumns } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const RadioGroup = Radio.Group

  type LevelFilter = 'ALL' | LogLevel

  const props = defineProps({
    logs: { type: Array as PropType<RecentLogItem[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    /** 生效中的自动刷新开关（受页面顶部总开关约束） */
    autoRefresh: { type: Boolean, default: true },
    /** 表体可视行数：运行监控页给 15 行，其它页保持默认高度 */
    visibleRows: { type: Number, default: 11 },
  })

  const emit = defineEmits(['update:autoRefresh'])

  const router = useRouter()
  const level = ref<LevelFilter>('ALL')

  /** antd small 尺寸单行约 25px，按可视行数换算 Table 固定表体高度 */
  const scrollY = computed(() => Math.max(Number(props.visibleRows) || 11, 1) * 25)

  const levelOptions = computed(() => {
    const counts = (props.logs || []).reduce((acc, item) => {
      acc[item.level] = (acc[item.level] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    return [
      { label: `全部 ${props.logs.length}`, value: 'ALL' as LevelFilter },
      { label: `INFO ${counts.INFO || 0}`, value: 'INFO' as LevelFilter },
      { label: `WARN ${counts.WARN || 0}`, value: 'WARN' as LevelFilter },
      { label: `ERROR ${counts.ERROR || 0}`, value: 'ERROR' as LevelFilter },
    ]
  })

  const filtered = computed(() =>
    level.value === 'ALL'
      ? props.logs
      : (props.logs || []).filter((item) => item.level === level.value),
  )

  function rowClassName(record: RecentLogItem) {
    return record.level === 'ERROR' ? 'log-row-error' : ''
  }

  /** 行点击：有 taskId 时带上下钻（日志页按 route.query.taskId 预选任务），否则进日志页自选 */
  function customRow(record: RecentLogItem) {
    return {
      onClick: () =>
        router.push(
          record.taskId
            ? `/databridge/log?taskId=${encodeURIComponent(record.taskId)}`
            : '/databridge/log',
        ),
    }
  }

  function handleSwitchChange(checked: boolean) {
    emit('update:autoRefresh', checked)
  }
</script>

<style lang="less" scoped>
  .mono,
  .log-message {
    font-family: monospace;
  }

  .auto-hint {
    color: #8c8c8c;
    font-size: 12px;
  }

  :deep(.log-row-error) {
    td {
      color: #cf1322;
      background-color: #fff1f0;
    }
  }

  :deep(.ant-table-row) {
    cursor: pointer;
  }
</style>
