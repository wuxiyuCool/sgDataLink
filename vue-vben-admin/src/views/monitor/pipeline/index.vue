<template>
  <PageWrapper
    title="管道监控"
    content="数据来源：GET /pipelines（左侧列表与状态点）+ GET /pipelines/:id/status（选中管道 3s 轮询 QPS / 延迟 / 变更行数 / CDC 位点）+ GET /task-instances/:id/logs（该管道运行实例日志，10s 轮询）。QPS / 延迟曲线由前端本地采样拼出，不落库。"
  >
    <template #headerContent>
      <MonitorToolbar
        v-model="autoRefresh"
        rule="实时指标 3s · 实例日志 10s"
        :updated="statusUpdatedAt"
        :hint="`指标 ${statusUpdatedAt || '-'} / 日志 ${logsUpdatedAt || '-'}`"
        :loading="manualLoading"
        @refresh="handleRefreshAll"
      >
        <Tag>{{ pipelines.length }} 条管道</Tag>
        <Tag v-if="runningCount" color="processing">{{ runningCount }} 条运行中</Tag>
        <Tag v-else>无运行管道</Tag>
      </MonitorToolbar>
    </template>

    <Row :gutter="[16, 16]">
      <!-- 1. 左侧管道列表：状态点 + 行内启停 -->
      <Col :xs="24" :lg="7">
        <PanelCard
          title="数据管道"
          icon="ant-design:partition-outlined"
          hint="来自 GET /pipelines（一次拉全量，size=500）。绿/紫脉冲点表示 running，灰点表示 stopped；status 为 running 的管道每 3 秒再校验一次实时状态"
          :loading="listLoading"
          :error="listError"
          :skeleton-rows="8"
        >
          <template #extra>
            <Space :size="4">
              <Button size="small" type="link" :loading="listLoading" @click="loadPipelines">
                刷新
              </Button>
              <Button size="small" type="link" @click="goCreate">新建</Button>
            </Space>
          </template>

          <Empty v-if="!pipelines.length" :description="DASH_EMPTY_TEXT.pipeline">
            <Button type="primary" @click="goCreate">
              <Icon icon="ant-design:plus-outlined" class="mr-1" />
              去创建数据管道
            </Button>
          </Empty>

          <ul v-else class="pipe-list">
            <li
              v-for="item in pipelines"
              :key="item.id"
              class="pipe-list__item"
              :class="{ 'pipe-list__item--active': item.id === selectedId }"
              @click="handleSelect(item.id)"
            >
              <span
                class="pipe-list__dot"
                :class="isRunning(item) ? 'pipe-list__dot--running' : 'pipe-list__dot--stopped'"
              ></span>
              <div class="pipe-list__main">
                <Tooltip :title="item.name">
                  <div class="pipe-list__name">{{ item.name }}</div>
                </Tooltip>
                <div class="pipe-list__meta">
                  {{ item.id }} · {{ (item.syncObjects || []).length }} 张表 ·
                  {{ getPipelineStatusLabel(item.status) }}
                </div>
              </div>
              <Popconfirm
                v-if="isRunning(item)"
                title="确认停止该管道？停止后不再捕获新的变更事件"
                ok-text="停止"
                cancel-text="取消"
                @confirm="handleStop(item)"
              >
                <Button
                  size="small"
                  type="link"
                  danger
                  :loading="actionLoading === item.id"
                  @click.stop
                >
                  停止
                </Button>
              </Popconfirm>
              <Popconfirm
                v-else
                title="确认启动该管道？启动后引擎以 cdc 模式持续捕获变更"
                ok-text="启动"
                cancel-text="取消"
                @confirm="handleStart(item)"
              >
                <Button size="small" type="link" :loading="actionLoading === item.id" @click.stop>
                  启动
                </Button>
              </Popconfirm>
            </li>
          </ul>
        </PanelCard>
      </Col>

      <!-- 2. 右侧：选中管道的实时指标 / 采样曲线 / 实例日志 -->
      <Col :xs="24" :lg="17">
        <Empty
          v-if="!pipelines.length"
          class="pipe-placeholder"
          :description="DASH_EMPTY_TEXT.pipeline"
        >
          <Button type="primary" @click="goCreate">去创建数据管道</Button>
        </Empty>

        <template v-else>
          <Alert
            v-if="statusError"
            class="mb-3"
            type="error"
            show-icon
            closable
            message="管道实时状态获取失败"
            :description="statusError"
            @close="statusError = ''"
          />

          <div class="pipe-head">
            <div class="pipe-head__title">
              <Icon icon="ant-design:pulse-outlined" :color="DASH_COLORS.pipeline" />
              <span>{{ selectedPipeline?.name || '未选择管道' }}</span>
              <Tag :color="getPipelineStatusColor(selectedPipeline?.status)">
                {{ getPipelineStatusLabel(selectedPipeline?.status) }}
              </Tag>
            </div>
            <span class="pipe-head__desc">{{ endpointText }}</span>
          </div>

          <PipelineMetricCards class="mb-3" :status="status" :loading="statusLoading" />

          <div class="mb-3">
            <PipelineTrendChart
              :samples="samples"
              :label="trendLabel"
              :error="statusError"
              @clear="handleClearSamples"
            />
          </div>

          <PipelineLogPanel
            :logs="logs"
            :loading="logsLoading"
            :error="logsError"
            :instance-id="instanceId"
            :instance-label="logInstanceLabel"
            :auto-refresh="effectiveLogsRefresh"
            @update:auto-refresh="handleLogsRefreshChange"
          />
        </template>
      </Col>
    </Row>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, onUnmounted, ref, unref, watch } from 'vue'
  import { useRouter } from 'vue-router'
  import { Alert, Button, Col, Empty, Popconfirm, Row, Space, Tag, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import {
    getAllPipelinesApi,
    getPipelineStatusApi,
    startPipelineApi,
    stopPipelineApi,
  } from '/@/api/databridge/pipeline'
  import type { Pipeline, PipelineStatusResult } from '/@/api/databridge/model/pipelineModel'
  import { getTaskInstanceLogsApi } from '/@/api/databridge/taskInstance'
  import type { TaskLog } from '/@/api/databridge/model/taskInstanceModel'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import {
    getPipelineStatusLabel,
    getPipelineStatusColor,
    formatTimeAxis,
  } from '/@/views/databridge/data'
  import {
    DASH_COLORS,
    DASH_EMPTY_TEXT,
    LOG_POLL_INTERVAL,
    PIPELINE_POLL_INTERVAL,
    PIPELINE_SAMPLE_WINDOW,
  } from '../monitor.data'
  import type { PipelineSample } from '../monitor.data'
  import MonitorToolbar from '../components/MonitorToolbar.vue'
  import PanelCard from '../components/PanelCard.vue'
  import PipelineLogPanel from '../components/PipelineLogPanel.vue'
  import PipelineMetricCards from '../components/PipelineMetricCards.vue'
  import PipelineTrendChart from '../components/PipelineTrendChart.vue'

  const router = useRouter()
  const { createMessage, notification } = useMessage()

  const autoRefresh = ref(true)
  const logsAutoRefresh = ref(true)
  const effectiveLogsRefresh = computed(() => unref(autoRefresh) && unref(logsAutoRefresh))

  const manualLoading = ref(false)
  const actionLoading = ref('')
  const statusUpdatedAt = ref('')
  const logsUpdatedAt = ref('')

  const pipelines = ref<Pipeline[]>([])
  const listLoading = ref(false)
  const listError = ref('')

  const selectedId = ref('')
  const status = ref<PipelineStatusResult | null>(null)
  const statusLoading = ref(false)
  const statusError = ref('')

  const samples = ref<PipelineSample[]>([])

  const logs = ref<TaskLog[]>([])
  const logsLoading = ref(false)
  const logsError = ref('')

  const selectedPipeline = computed(() =>
    pipelines.value.find((item) => item.id === unref(selectedId)),
  )
  const runningCount = computed(() => pipelines.value.filter((item) => isRunning(item)).length)

  /** 日志跟着「当前运行实例」走：优先取 status 接口回报的 instanceId，回退列表字段 */
  const instanceId = computed(() =>
    String(status.value?.instanceId || selectedPipeline.value?.runningInstanceId || ''),
  )

  const trendLabel = computed(() =>
    selectedPipeline.value
      ? `${selectedPipeline.value.name} · ${selectedPipeline.value.id ?? ''}`
      : '',
  )

  const logInstanceLabel = computed(() =>
    instanceId.value ? `实例 ${instanceId.value}` : '该管道未运行',
  )

  /** 源 → 目标 + 同步对象数，作为右侧页头的一句话说明 */
  const endpointText = computed(() => {
    const row = selectedPipeline.value
    if (!row) return '请选择左侧一条管道'
    const objects = (row.syncObjects || []).join('、') || '未配置同步对象'
    return `${row.sourceId} → ${row.targetId} · ${objects}`
  })

  function isRunning(row: Pipeline) {
    return row.status === 'running'
  }

  /** 把一次 status 读数落到指标卡 + 追加一个采样点（仅运行中采样） */
  function applyStatus(result: PipelineStatusResult) {
    status.value = result
    statusError.value = ''
    statusUpdatedAt.value = formatTimeAxis(Date.now())
    const row = selectedPipeline.value
    if (row) {
      row.status = result.status || row.status
      row.currentQps = result.currentQps
      row.lagMs = result.lagMs
      row.changeRows = result.changeRows
      row.cdcPosition = result.cdcPosition
      row.runningInstanceId = result.instanceId ?? row.runningInstanceId
      row.statusAt = Date.now()
    }
    if (result.status !== 'running') return
    samples.value = [
      ...samples.value,
      {
        time: formatTimeAxis(Date.now()),
        qps: Number(result.currentQps || 0),
        lagMs: Number(result.lagMs || 0),
        changeRows: Number(result.changeRows || 0),
      },
    ].slice(-PIPELINE_SAMPLE_WINDOW)
  }

  async function pollStatus() {
    const id = unref(selectedId)
    if (!id) return
    // 首屏才给 loading，后续轮询静默更新，避免卡片每 3 秒闪一次骨架
    if (!unref(status)) statusLoading.value = true
    try {
      const result = await getPipelineStatusApi(id)
      if (result) applyStatus(result)
      else status.value = null
    } catch (error: unknown) {
      statusError.value = getApiErrorMessage(error, '实时状态接口不可用')
    } finally {
      statusLoading.value = false
    }
  }

  /** 刷新列表时顺带复核运行中管道的状态（可能已在别处被停掉） */
  async function loadPipelines(keepSelection = true) {
    if (!unref(pipelines).length) listLoading.value = true
    try {
      const list = await getAllPipelinesApi()
      pipelines.value = list ?? []
      listError.value = ''
      const stillExists = list?.some((item) => item.id === unref(selectedId))
      if (!keepSelection || !stillExists) {
        selectedId.value = pickDefaultPipeline(list ?? [])
      }
      await syncRunningStatus()
    } catch (error: unknown) {
      listError.value = getApiErrorMessage(error, '管道列表加载失败')
    } finally {
      listLoading.value = false
    }
  }

  /** 没有专门选中时，优先看第一条运行中的管道 */
  function pickDefaultPipeline(list: Pipeline[]) {
    const running = list.find((item) => isRunning(item))
    return String(running?.id ?? list[0]?.id ?? '')
  }

  async function syncRunningStatus() {
    const running = pipelines.value.filter((item) => isRunning(item))
    if (!running.length) return
    const results = await Promise.allSettled(
      running.map((item) => getPipelineStatusApi(item.id as string)),
    )
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return
      const row = running[index]
      row.status = result.value.status
      row.lagMs = result.value.lagMs
      row.currentQps = result.value.currentQps
      row.runningInstanceId = result.value.instanceId ?? row.runningInstanceId
    })
  }

  async function loadLogs() {
    const id = unref(instanceId)
    if (!id) {
      logs.value = []
      logsError.value = ''
      return
    }
    logsLoading.value = true
    try {
      const res = await getTaskInstanceLogsApi(id, { page: 1, size: 60 })
      logs.value = res?.items ?? []
      logsError.value = ''
      logsUpdatedAt.value = formatTimeAxis(Date.now())
    } catch (error: unknown) {
      logsError.value = getApiErrorMessage(error, '实例日志加载失败')
    } finally {
      logsLoading.value = false
    }
  }

  function handleSelect(id?: string) {
    if (!id || id === unref(selectedId)) return
    selectedId.value = id
  }

  function handleClearSamples() {
    samples.value = []
  }

  function handleLogsRefreshChange(checked: boolean) {
    logsAutoRefresh.value = checked
    if (checked) autoRefresh.value = true
  }

  async function handleStart(row: Pipeline) {
    if (!row.id) return
    actionLoading.value = row.id
    try {
      const result = await startPipelineApi(row.id)
      notification.success({
        message: '管道启动指令已下发',
        description: `【${row.name}】运行实例 instanceId：${result?.instanceId ?? '-'}`,
        duration: 5,
      })
      samples.value = []
      status.value = null
      await loadPipelines()
      await Promise.allSettled([pollStatus(), loadLogs()])
    } catch (error: unknown) {
      createMessage.error(getApiErrorMessage(error, '启动失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleStop(row: Pipeline) {
    if (!row.id) return
    actionLoading.value = row.id
    try {
      await stopPipelineApi(row.id)
      createMessage.success(`管道【${row.name}】正在停止`)
      await loadPipelines()
      await pollStatus()
    } catch (error: unknown) {
      createMessage.error(getApiErrorMessage(error, '停止失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  function goCreate() {
    router.push('/databridge/pipeline')
  }

  async function handleRefreshAll() {
    manualLoading.value = true
    try {
      await loadPipelines()
      await Promise.allSettled([pollStatus(), loadLogs()])
    } finally {
      manualLoading.value = false
    }
  }

  let statusTimer: IntervalHandle | null = null
  let logsTimer: IntervalHandle | null = null

  function clearTimers() {
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
    if (logsTimer) {
      clearInterval(logsTimer)
      logsTimer = null
    }
  }

  /** 3s 指标 + 10s 日志；总开关关掉即全部停止 */
  function syncTimers() {
    clearTimers()
    if (!unref(autoRefresh)) return
    statusTimer = setInterval(pollStatus, PIPELINE_POLL_INTERVAL)
    if (unref(logsAutoRefresh)) logsTimer = setInterval(loadLogs, LOG_POLL_INTERVAL)
  }

  // 切换管道即重置右侧：曲线只描述当前这一条管道，不能把两条的数据串在一起
  // booting 期间由 onMounted 统一首屏取数，避免同一份数据被请求两遍
  let booting = true

  watch(selectedId, () => {
    samples.value = []
    status.value = null
    statusError.value = ''
    logs.value = []
    if (booting) return
    clearTimers()
    if (unref(selectedId)) {
      pollStatus()
      loadLogs()
    }
    syncTimers()
  })

  watch([autoRefresh, logsAutoRefresh], syncTimers)

  onMounted(async () => {
    await loadPipelines(false)
    if (unref(selectedId)) {
      await Promise.allSettled([pollStatus(), loadLogs()])
    }
    booting = false
    syncTimers()
  })

  onUnmounted(clearTimers)
</script>

<style lang="less" scoped>
  .pipe-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;

    &__title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
    }

    &__desc {
      max-width: 100%;
      overflow: hidden;
      color: #8c8c8c;
      font-size: 12px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .pipe-list {
    max-height: 520px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;

    &__item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 6px;
      border-bottom: 1px dashed #f0f0f0;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover {
        background-color: rgba(114, 46, 209, 0.06);
      }

      &:last-child {
        border-bottom: none;
      }

      &--active {
        background-color: rgba(114, 46, 209, 0.1);
      }
    }

    &__dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;

      &--running {
        background-color: #722ed1;
        animation: pipe-dot 1.2s ease-in-out infinite;
      }

      &--stopped {
        background-color: #bfbfbf;
      }
    }

    &__main {
      flex: 1;
      min-width: 0;
    }

    &__name {
      overflow: hidden;
      font-weight: 500;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    &__meta {
      overflow: hidden;
      color: #8c8c8c;
      font-size: 12px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
  }

  .pipe-placeholder {
    padding-top: 60px;
  }

  @keyframes pipe-dot {
    0% {
      opacity: 0.35;
      transform: scale(0.8);
    }

    50% {
      opacity: 1;
      transform: scale(1.3);
    }

    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
  }
</style>
