<template>
  <PanelCard
    title="管道实例日志"
    icon="ant-design:file-text-outlined"
    hint="来自 GET /task-instances/:id/logs（取该管道当前运行实例的引擎回报日志，契约 1.4）；默认每 10 秒拉取一次，可单独关闭"
    :loading="loading"
    :error="error"
    :skeleton-rows="5"
  >
    <template #extra>
      <Space :size="10">
        <span class="instance-label">{{ instanceLabel }}</span>
        <span class="auto-hint">自动刷新(10s)</span>
        <Switch :checked="autoRefresh" size="small" @change="handleSwitchChange" />
      </Space>
    </template>

    <Empty
      v-if="!logs.length && !loading"
      :description="
        instanceId ? DASH_EMPTY_TEXT.logs : '该管道当前没有运行实例，启动后才会产生日志'
      "
    />
    <Table
      v-else
      :columns="pipelineLogColumns"
      :data-source="logs"
      :pagination="false"
      :scroll="{ x: 720, y: 250 }"
      row-key="id"
      size="small"
      :row-class-name="rowClassName"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'createdAt'">
          <span class="mono">{{ formatTime(record.createdAt) }}</span>
        </template>
        <template v-else-if="column.key === 'level'">
          <Tag :color="LOG_LEVEL_TAG_COLORS[record.level] || 'default'">{{ record.level }}</Tag>
        </template>
        <template v-else-if="column.key === 'message'">
          <span class="log-message">{{ record.message || '-' }}</span>
        </template>
      </template>
    </Table>
  </PanelCard>
</template>

<script lang="ts" setup>
  import type { PropType } from 'vue'
  import { Empty, Space, Switch, Table, Tag } from 'ant-design-vue'
  import { LOG_LEVEL_TAG_COLORS, formatTime } from '/@/views/databridge/data'
  import type { TaskLog } from '/@/api/databridge/model/taskInstanceModel'
  import { DASH_EMPTY_TEXT, pipelineLogColumns } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  defineProps({
    logs: { type: Array as PropType<TaskLog[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    /** 该管道当前运行实例 id，为空表示管道未运行 */
    instanceId: { type: String, default: '' },
    instanceLabel: { type: String, default: '' },
    autoRefresh: { type: Boolean, default: true },
  })

  const emit = defineEmits(['update:autoRefresh'])

  function rowClassName(record: TaskLog) {
    return record.level === 'ERROR' ? 'log-row-error' : ''
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

  .auto-hint,
  .instance-label {
    color: #8c8c8c;
    font-size: 12px;
  }

  :deep(.log-row-error) {
    td {
      color: #cf1322;
      background-color: #fff1f0;
    }
  }
</style>
