<template>
  <PanelCard
    title="运行中实例"
    icon="ant-design:rocket-outlined"
    hint="每 3 秒轮询 GET /task-instances?status=running，并按归属补充进度接口：任务/画布走 /progress，管道走 /pipelines/:id/status；点击行可在下方追踪该实例的进度曲线"
    :loading="loading"
    :error="error"
    :skeleton-rows="6"
  >
    <template #extra>
      <Space :size="8">
        <Tag v-if="rows.length" color="processing">{{ rows.length }} 个实例在跑</Tag>
        <span class="poll-hint">{{ selectedLabel ? `追踪：${selectedLabel}` : '未选择实例' }}</span>
      </Space>
    </template>

    <Empty v-if="!rows.length && !error" :description="DASH_EMPTY_TEXT.running">
      <Button type="primary" @click="goCreateTask">
        <Icon icon="ant-design:plus-outlined" class="mr-1" />
        去创建任务
      </Button>
    </Empty>

    <Table
      v-else
      :columns="runningInstanceColumns"
      :data-source="rows"
      :loading="loading"
      :pagination="false"
      :scroll="{ x: 1385, y: 320 }"
      row-key="id"
      size="small"
      :row-class-name="rowClassName"
      :custom-row="customRow"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'id'">
          <span class="mono">{{ record.id }}</span>
        </template>
        <template v-else-if="column.key === 'name'">
          <Tooltip
            :title="`${instanceKindMetaOf(record).label} · ${
              record.taskId || record.pipelineId || '-'
            }`"
          >
            <span class="name-cell">
              <Tag :color="instanceKindMetaOf(record).color" class="name-cell__tag">
                {{ instanceKindMetaOf(record).label }}
              </Tag>
              <span class="name-cell__text">{{
                record.taskName || record.taskId || record.id
              }}</span>
            </span>
          </Tooltip>
        </template>
        <template v-else-if="column.key === 'syncMode'">
          <Tag :color="modeTagColor(record)">
            {{ getSyncModeLabel(record.syncMode) }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'status'">
          <Space :size="4">
            <Tag :color="getTaskStatusColor(record.status)">
              {{ getTaskStatusLabel(record.status) }}
            </Tag>
            <!-- 执行模式标识（契约 4.1）：模拟实例的进度/行数并非真实读写结果 -->
            <Tooltip v-if="record.execMode" :title="execModeTip(record.execMode)">
              <Tag :color="getExecModeColor(record.execMode)">
                {{ getExecModeLabel(record.execMode) }}
              </Tag>
            </Tooltip>
          </Space>
        </template>
        <template v-else-if="column.key === 'progress'">
          <!-- CDC 管道没有百分比终点：用脉冲样式表达「持续同步中」 -->
          <Tooltip
            v-if="isPipelineInstance(record)"
            :title="
              record.lastError
                ? `管道异常：${record.lastError}`
                : '实时镜像无完成终点，按 tick 持续捕获变更'
            "
          >
            <span class="pulse" :class="{ 'pulse--error': !!record.lastError }">
              <span class="pulse__dot"></span>
              持续同步中
            </span>
          </Tooltip>
          <Progress
            v-else
            :percent="Number(record.progress || 0)"
            size="small"
            :status="getProgressStatus(record.status)"
          />
        </template>
        <template v-else-if="column.key === 'rows'">
          <Tooltip :title="rowsTooltip(record)">
            <span class="rows-cell">
              {{ formatNumber(record.readRows) }} /
              {{ formatNumber(pipelineRows(record)) }}
            </span>
          </Tooltip>
        </template>
        <template v-else-if="column.key === 'rate'">
          <span class="rate-cell">{{ formatNumber(rateOf(record)) }}</span>
          <span class="rate-cell__unit">{{ isPipelineInstance(record) ? ' qps' : ' r/s' }}</span>
        </template>
        <template v-else-if="column.key === 'position'">
          <div class="position-cell">
            <Tooltip :title="positionOf(record) || '-'">
              <span class="mono">{{ positionOf(record) || '-' }}</span>
            </Tooltip>
            <span
              v-if="
                isPipelineInstance(record) && record.lagMs !== undefined && record.lagMs !== null
              "
              :class="isLagOverThreshold(record.lagMs) ? 'lag-danger' : 'lag-normal'"
            >
              延迟 {{ formatLag(record.lagMs) }}
            </span>
          </div>
        </template>
        <template v-else-if="column.key === 'startedAt'">
          <Tooltip :title="`已运行 ${formatDuration(elapsedOf(record))}`">
            <span>{{ formatTime(record.startedAt) }}</span>
          </Tooltip>
        </template>
      </template>
    </Table>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { useRouter } from 'vue-router'
  import { Button, Empty, Progress, Space, Table, Tag, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import type { ExecMode } from '/@/api/databridge/model/commonModel'
  import {
    EXEC_MODE_REAL_TIP,
    EXEC_MODE_SIMULATE_TIP,
    SYNC_MODE_TAG_COLORS,
    formatLag,
    formatNumber,
    formatTime,
    getExecModeColor,
    getExecModeLabel,
    getProgressStatus,
    getSyncModeLabel,
    getTaskStatusLabel,
    getTaskStatusColor,
    isLagOverThreshold,
  } from '/@/views/databridge/data'
  import {
    DASH_EMPTY_TEXT,
    formatDuration,
    instanceKindMetaOf,
    isPipelineInstance,
    runningInstanceColumns,
  } from '../monitor.data'
  import type { RunningRow } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    rows: { type: Array as PropType<RunningRow[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    selectedId: { type: String, default: '' },
  })

  const emit = defineEmits(['select'])

  const router = useRouter()

  const rows = computed(() => props.rows || [])
  const selectedLabel = computed(() => {
    const row = rows.value.find((item) => item.id === props.selectedId)
    return row ? `${row.taskName || row.taskId || row.id} · ${row.id}` : ''
  })

  /** 同步模式 Tag 配色（cdc 由管道承载，色值与全站一致） */
  function modeTagColor(row: RunningRow) {
    return (row.syncMode && SYNC_MODE_TAG_COLORS[row.syncMode]) || 'default'
  }

  /** 执行模式悬浮说明（契约 4.1）：模拟态解释成因，真实态说明数据来源 */
  function execModeTip(mode: ExecMode) {
    return mode === 'simulate' ? EXEC_MODE_SIMULATE_TIP : EXEC_MODE_REAL_TIP
  }

  /** 管道行的第二列为累计变更行数，任务/画布行为已写行数 */
  function pipelineRows(row: RunningRow) {
    return isPipelineInstance(row) ? row.changeRows ?? row.writeRows : row.writeRows
  }

  function rowsTooltip(row: RunningRow) {
    const read = `已读 ${formatNumber(row.readRows)}`
    if (isPipelineInstance(row)) {
      return `${read} · 累计变更 ${formatNumber(row.changeRows)} · 已写 ${formatNumber(
        row.writeRows,
      )}`
    }
    return `${read} · 已写 ${formatNumber(row.writeRows)} · 总行数 ${formatNumber(row.totalRows)}`
  }

  function rateOf(row: RunningRow) {
    return (
      Number(isPipelineInstance(row) ? row.currentQps ?? row.rateRowsPerSec : row.rateRowsPerSec) ||
      0
    )
  }

  function positionOf(row: RunningRow) {
    return isPipelineInstance(row) ? row.cdcPosition || '' : row.currentOffset || ''
  }

  /** 已运行时长以本地采样时间为基准，避免每秒抖动（数据本身 3 秒刷新一次） */
  function elapsedOf(row: RunningRow) {
    const start = row.startedAt ? Date.parse(row.startedAt) : NaN
    if (!Number.isFinite(start)) return 0
    return Math.max((row.updatedAtLocal || Date.now()) - start, 0)
  }

  function rowClassName(row: RunningRow) {
    return row.id === props.selectedId ? 'row-tracked' : ''
  }

  function customRow(row: RunningRow) {
    return {
      onClick: () => emit('select', row.id),
    }
  }

  function goCreateTask() {
    router.push('/databridge/task')
  }
</script>

<style lang="less" scoped>
  .mono {
    font-family: monospace;
  }

  .poll-hint {
    color: #8c8c8c;
    font-size: 12px;
  }

  .name-cell {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    overflow: hidden;

    &__tag {
      flex: none;
      margin-right: 6px;
    }

    &__text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .rows-cell {
    font-variant-numeric: tabular-nums;
  }

  .rate-cell {
    font-weight: 600;
    font-variant-numeric: tabular-nums;

    &__unit {
      color: #8c8c8c;
      font-size: 12px;
    }
  }

  .position-cell {
    display: flex;
    flex-direction: column;
    line-height: 18px;

    .mono {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .lag-normal {
    color: #52c41a;
    font-size: 12px;
  }

  .lag-danger {
    color: #cf1322;
    font-size: 12px;
    font-weight: 600;
  }

  /* CDC 脉冲：呼吸点 + 文案，替代没有终点的百分比条 */
  .pulse {
    display: inline-flex;
    align-items: center;
    color: #722ed1;
    font-size: 12px;

    &__dot {
      width: 8px;
      height: 8px;
      margin-right: 6px;
      background-color: currentColor;
      border-radius: 50%;
      animation: pulse-dot 1.2s ease-in-out infinite;
    }

    &--error {
      color: #ff4d4f;
    }
  }

  @keyframes pulse-dot {
    0% {
      opacity: 0.35;
      transform: scale(0.8);
    }

    50% {
      opacity: 1;
      transform: scale(1.25);
    }

    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
  }

  :deep(.row-tracked) {
    td {
      background-color: rgba(24, 144, 255, 0.08);
    }
  }

  :deep(.ant-table-row) {
    cursor: pointer;
  }
</style>
