<template>
  <PageWrapper
    title="运行监控"
    content="数据来源：GET /task-instances?status=running（3s 轮询）+ 各归属进度接口（任务 /tasks/:id/progress、画布 /dataflows/:id/progress、管道 /pipelines/:id/status）+ GET /statistics/overview 的 recentLogs（10s 轮询）。进度曲线为前端本地采样，仅存在于本页内存。"
  >
    <template #headerContent>
      <MonitorToolbar
        v-model="autoRefresh"
        rule="运行实例 3s · 日志流 10s"
        :updated="runningUpdatedAt"
        :hint="`实例 ${runningUpdatedAt || '-'} / 日志 ${logsUpdatedAt || '-'}`"
        :loading="manualLoading"
        @refresh="handleRefreshAll"
      >
        <Tag v-if="runningRows.length" color="processing">{{ runningRows.length }} 个实例在跑</Tag>
        <Tag v-else>暂无运行实例</Tag>
      </MonitorToolbar>
    </template>

    <div class="monitor-body">
      <!-- 1. 运行中实例表（3s），点击行切换下方曲线与日志的追踪对象 -->
      <Row :gutter="[16, 16]" class="mb-3">
        <Col :span="24">
          <RunningInstancePanel
            :rows="runningRows"
            :loading="runningLoading"
            :error="runningError"
            :selected-id="selectedId"
            @select="handleSelect"
          />
        </Col>
      </Row>

      <!-- 2. 所选实例的本地进度采样曲线 -->
      <Row :gutter="[16, 16]" class="mb-3">
        <Col :span="24">
          <ProgressTracePanel
            :samples="selectedSamples"
            :label="selectedLabel"
            @clear="handleClearSamples"
          />
        </Col>
      </Row>

      <!-- 3. 实时日志流（10s + 级别过滤），本页给 15 行可视高度 -->
      <Row :gutter="[16, 16]">
        <Col :span="24">
          <LogStreamPanel
            :logs="logs"
            :loading="logsLoading"
            :error="logsError"
            :auto-refresh="effectiveLogsRefresh"
            :visible-rows="LOG_VISIBLE_ROWS"
            @update:auto-refresh="handleLogsRefreshChange"
          />
        </Col>
      </Row>
    </div>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, onUnmounted, ref, unref, watch } from 'vue'
  import { Col, Row, Tag } from 'ant-design-vue'
  import { PageWrapper } from '/@/components/Page'
  import { getTaskInstanceListApi } from '/@/api/databridge/taskInstance'
  import { getTaskProgressApi } from '/@/api/databridge/task'
  import { getDataflowProgressApi } from '/@/api/databridge/dataflow'
  import { getPipelineStatusApi } from '/@/api/databridge/pipeline'
  import { getStatisticsOverviewApi } from '/@/api/databridge/statistics'
  import type { RecentLogItem } from '/@/api/databridge/statistics'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { TaskInstance } from '/@/api/databridge/model/taskInstanceModel'
  import type { PipelineStatusResult } from '/@/api/databridge/model/pipelineModel'
  import type { DataflowProgress } from '/@/api/databridge/model/dataflowModel'
  import type { TaskProgress } from '/@/api/databridge/model/taskModel'
  import { formatTimeAxis } from '/@/views/databridge/data'
  import {
    LOG_POLL_INTERVAL,
    MAX_PROGRESS_SAMPLES,
    RUNNING_POLL_INTERVAL,
    instanceKindOf,
  } from '../monitor.data'
  import type { ProgressSample, RunningRow } from '../monitor.data'
  import LogStreamPanel from '../components/LogStreamPanel.vue'
  import MonitorToolbar from '../components/MonitorToolbar.vue'
  import ProgressTracePanel from '../components/ProgressTracePanel.vue'
  import RunningInstancePanel from '../components/RunningInstancePanel.vue'

  /**
   * 进度/状态接口返回的字段合集（契约 1.2 / 1.7 / 1.8 三种视图的并集），
   * 用于把「任务进度」「画布进度」「管道实时状态」三种返回归一进同一行表格数据。
   */
  interface RunDetail {
    status?: string
    progress?: number
    readRows?: number
    writeRows?: number
    totalRows?: number
    rateRowsPerSec?: number
    currentOffset?: string | null
    changeRows?: number
    currentQps?: number
    lagMs?: number
    cdcPosition?: string | null
    lastError?: string | null
  }

  /** 本页日志流按「可视 15 行」加高（recentLogs 单次正好 15 条，不需要翻页） */
  const LOG_VISIBLE_ROWS = 15

  const autoRefresh = ref(true)
  const logsAutoRefresh = ref(true)
  const effectiveLogsRefresh = computed(() => unref(autoRefresh) && unref(logsAutoRefresh))

  const manualLoading = ref(false)
  const runningUpdatedAt = ref('')
  const logsUpdatedAt = ref('')

  const logs = ref<RecentLogItem[]>([])
  const logsLoading = ref(false)
  const logsError = ref('')

  const runningRows = ref<RunningRow[]>([])
  const runningLoading = ref(false)
  const runningError = ref('')

  /** 进度曲线采样点按实例 id 分组存放：切换追踪对象不会把两条实例的曲线串在一起 */
  const samples = ref<Record<string, ProgressSample[]>>({})
  const selectedId = ref('')

  const selectedRow = computed(() =>
    unref(runningRows).find((item) => item.id === unref(selectedId)),
  )
  const selectedSamples = computed(() => samples.value[unref(selectedId)] ?? [])
  const selectedLabel = computed(() => {
    const row = unref(selectedRow)
    return row ? `${row.taskName || row.taskId || row.id} · ${row.id}` : ''
  })

  /** 按实例归属选择进度来源：管道走 /pipelines/:id/status，画布走 /dataflows/:id/progress */
  function detailOf(
    row: TaskInstance,
  ): Promise<PipelineStatusResult | TaskProgress | DataflowProgress | null> {
    const kind = instanceKindOf(row)
    if (kind === 'pipeline' && row.pipelineId) return getPipelineStatusApi(row.pipelineId)
    if (kind === 'dataflow' && row.taskId) return getDataflowProgressApi(row.taskId)
    if (kind === 'task' && row.taskId) return getTaskProgressApi(row.taskId)
    return Promise.resolve(null)
  }

  function applyDetail(row: RunningRow, detail: RunDetail | null) {
    if (!detail) return
    row.status = (detail.status || row.status) as RunningRow['status']
    row.progress = detail.progress ?? row.progress
    row.readRows = detail.readRows ?? row.readRows
    row.writeRows = detail.writeRows ?? row.writeRows
    row.totalRows = detail.totalRows ?? row.totalRows
    row.rateRowsPerSec = detail.rateRowsPerSec ?? row.rateRowsPerSec
    row.currentOffset = detail.currentOffset ?? row.currentOffset
    row.changeRows = detail.changeRows ?? row.changeRows
    row.currentQps = detail.currentQps ?? row.currentQps
    row.lagMs = detail.lagMs ?? row.lagMs
    row.cdcPosition = detail.cdcPosition ?? row.cdcPosition
    row.lastError = detail.lastError ?? row.lastError
  }

  function rateOf(row: RunningRow) {
    const kind = instanceKindOf(row)
    return (
      Number(kind === 'pipeline' ? row.currentQps ?? row.rateRowsPerSec : row.rateRowsPerSec) || 0
    )
  }

  /** 每个运行实例各留一条采样链（最近 MAX_PROGRESS_SAMPLES 个点），并顺手清掉已不在跑的实例 */
  function collectSamples(rows: RunningRow[]) {
    const time = formatTimeAxis(Date.now())
    const next: Record<string, ProgressSample[]> = {}
    rows.forEach((row) => {
      const prev = samples.value[row.id] ?? []
      next[row.id] = [
        ...prev,
        {
          time,
          progress: Number(row.progress || 0),
          readRows: Number(row.readRows || 0),
          writeRows: Number(row.writeRows || 0),
          rate: rateOf(row),
        },
      ].slice(-MAX_PROGRESS_SAMPLES)
    })
    samples.value = next
  }

  async function loadRunning() {
    // 只有首屏（还没有行）才显示表格 loading，避免 3 秒一次的闪烁打断阅读
    if (!unref(runningRows).length) runningLoading.value = true
    try {
      const res = await getTaskInstanceListApi({ page: 1, size: 100, status: 'running' })
      const rows: RunningRow[] = (res?.items ?? []).map((item) => ({
        ...item,
        updatedAtLocal: Date.now(),
      }))
      // 单行进度失败不影响其它行：allSettled 后只合并成功的那部分
      const details = await Promise.allSettled(rows.map((row) => detailOf(row)))
      details.forEach((detail, index) => {
        if (detail.status === 'fulfilled') {
          applyDetail(rows[index], (detail.value as RunDetail | null) ?? null)
        }
      })
      runningRows.value = rows
      runningError.value = ''
      runningUpdatedAt.value = formatTimeAxis(Date.now())
      if (!unref(selectedId) || !rows.some((row) => row.id === unref(selectedId))) {
        selectedId.value = rows.length ? rows[0].id : ''
      }
      collectSamples(rows)
    } catch (error: unknown) {
      runningError.value = getApiErrorMessage(error, '运行中实例加载失败')
    } finally {
      runningLoading.value = false
    }
  }

  /**
   * 日志流刷新：契约里没有全局日志列表端点（/task-instances/:id/logs 需要实例 id），
   * 因此 10s 刷新走 overview 的 recentLogs，只取日志字段。
   */
  async function loadLogs() {
    logsLoading.value = true
    try {
      const res = await getStatisticsOverviewApi()
      logs.value = res?.recentLogs ?? []
      logsError.value = ''
      logsUpdatedAt.value = formatTimeAxis(Date.now())
    } catch (error: unknown) {
      logsError.value = getApiErrorMessage(error, '运行日志加载失败')
    } finally {
      logsLoading.value = false
    }
  }

  function handleSelect(id: string) {
    selectedId.value = id
  }

  function handleClearSamples() {
    const id = unref(selectedId)
    if (!id) return
    samples.value = { ...samples.value, [id]: [] }
  }

  function handleLogsRefreshChange(checked: boolean) {
    logsAutoRefresh.value = checked
    // 单独把日志流打开时顺带恢复全局自动刷新，避免「开关打了但没在轮询」的错觉
    if (checked) autoRefresh.value = true
  }

  async function handleRefreshAll() {
    manualLoading.value = true
    try {
      await Promise.allSettled([loadRunning(), loadLogs()])
    } finally {
      manualLoading.value = false
    }
  }

  let runningTimer: IntervalHandle | null = null
  let logsTimer: IntervalHandle | null = null

  function clearTimers() {
    if (runningTimer) {
      clearInterval(runningTimer)
      runningTimer = null
    }
    if (logsTimer) {
      clearInterval(logsTimer)
      logsTimer = null
    }
  }

  /** 按开关联动重建两个定时器：3s 运行实例 / 10s 日志流 */
  function syncTimers() {
    clearTimers()
    if (!unref(autoRefresh)) return
    runningTimer = setInterval(loadRunning, RUNNING_POLL_INTERVAL)
    if (unref(logsAutoRefresh)) logsTimer = setInterval(loadLogs, LOG_POLL_INTERVAL)
  }

  watch([autoRefresh, logsAutoRefresh], syncTimers)

  onMounted(async () => {
    await Promise.allSettled([loadRunning(), loadLogs()])
    syncTimers()
  })

  onUnmounted(() => {
    clearTimers()
  })
</script>

<style lang="less" scoped>
  .monitor-body {
    width: 100%;
  }
</style>
