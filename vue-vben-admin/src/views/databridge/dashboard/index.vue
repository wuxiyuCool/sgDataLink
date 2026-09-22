<template>
  <PageWrapper
    title="任务监控大盘"
    content="顶部统计卡与近 7 天趋势来自 GET /statistics/overview；运行中的任务每 3 秒轮询 /task-instances?status=running 与 /tasks/:id/progress"
  >
    <template #headerContent>
      <div class="flex items-center justify-between">
        <span>
          管理后端状态：
          <Tag :color="healthTag.color">{{ healthTag.text }}</Tag>
        </span>
        <Space>
          <span class="text-gray-500">自动轮询(3s)</span>
          <Switch v-model:checked="polling" @change="handlePollingChange" />
          <Button @click="handleRefresh">
            <Icon icon="ant-design:reload-outlined" class="mr-1" />
            立即刷新
          </Button>
        </Space>
      </div>
    </template>

    <Row :gutter="[16, 16]" class="mb-3">
      <Col v-for="item in statisticCards" :key="item.title" :xs="12" :sm="12" :md="8" :lg="4">
        <Card :bordered="false" :loading="statsLoading">
          <Statistic :title="item.title" :value="item.value" :value-style="item.valueStyle">
            <template #prefix>
              <Icon :icon="item.icon" />
            </template>
          </Statistic>
          <div class="stat-hint">{{ item.hint }}</div>
        </Card>
      </Col>
    </Row>

    <Card :bordered="false" class="mb-3" title="最近 7 天执行趋势（成功 / 失败）">
      <div class="mb-1 text-gray-500">
        数据来自 GET /statistics/overview 的 recentTrend，按运行实例 startedAt 日期聚合
      </div>
      <Empty v-if="!trend.length" description="暂无趋势数据（后端未返回 recentTrend）" />
      <div
        v-show="trend.length"
        ref="trendChartRef"
        :style="{ width: '100%', height: '300px' }"
      ></div>
    </Card>

    <Card :bordered="false" class="mb-3" title="运行中任务进度（点击行可追踪该实例的进度曲线）">
      <Table
        :columns="progressColumns"
        :data-source="runningRows"
        :loading="runningLoading"
        :pagination="false"
        :scroll="{ x: 1200 }"
        row-key="id"
        size="middle"
        :row-class-name="getRowClassName"
        :custom-row="customRow"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <Tag :color="getTaskStatusColor(record.status)">{{ record.status }}</Tag>
          </template>
          <template v-else-if="column.key === 'progress'">
            <Progress
              :percent="Number(record.progress || 0)"
              size="small"
              :status="getProgressStatus(record.status)"
            />
          </template>
          <template v-else-if="column.key === 'rows'">
            {{ formatNumber(record.readRows) }} / {{ formatNumber(record.writeRows) }} /
            {{ formatNumber(record.totalRows) }}
          </template>
          <template v-else-if="column.key === 'rateRowsPerSec'">
            {{ formatNumber(record.rateRowsPerSec) }} rows/s
          </template>
          <template v-else-if="column.key === 'currentOffset'">
            <span class="offset-text">{{ record.currentOffset || '-' }}</span>
          </template>
          <template v-else-if="column.key === 'startedAt'">
            {{ formatTime(record.startedAt) }}
          </template>
        </template>
      </Table>
      <div class="mt-2 text-gray-500">
        当前追踪实例：{{ selectedLabel || '（未选择，默认追踪第一条运行中实例）' }}
        <Button v-if="samples.length" type="link" size="small" @click="samples = []">
          清空采样点
        </Button>
      </div>
    </Card>

    <Card :bordered="false" title="所选实例进度变化（本地累积采样点）">
      <Empty v-if="!samples.length" description="等待采样点（每 3 秒一次）" />
      <div ref="chartRef" :style="{ width: '100%', height: '320px' }"></div>
    </Card>
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { computed, onMounted, onUnmounted, reactive, ref, unref } from 'vue'
  import type { Ref } from 'vue'
  import {
    Button,
    Card,
    Col,
    Empty,
    Progress,
    Row,
    Space,
    Statistic,
    Switch,
    Table,
    Tag,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useECharts } from '/@/hooks/web/useECharts'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getTaskProgressApi } from '/@/api/databridge/task'
  import { getPipelineStatusApi } from '/@/api/databridge/pipeline'
  import { getTaskInstanceListApi } from '/@/api/databridge/taskInstance'
  import { getHealthApi, type HealthResult } from '/@/api/databridge/health'
  import { getStatisticsOverviewApi, type StatisticsTrendItem } from '/@/api/databridge/statistics'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { TaskInstance } from '/@/api/databridge/model/taskInstanceModel'
  import type { TaskProgress } from '/@/api/databridge/model/taskModel'
  import type { TableColumn } from '../data'
  import {
    POLL_INTERVAL,
    formatNumber,
    formatTime,
    formatTimeAxis,
    getProgressStatus,
    getTaskStatusColor,
  } from '../data'

  interface RunningRow extends TaskInstance {
    rateRowsPerSec?: number
    currentOffset?: string | null
  }

  interface SamplePoint {
    time: string
    progress: number
    readRows: number
    rate: number
  }

  const { createMessage } = useMessage()
  const chartRef = ref<HTMLDivElement | null>(null)
  const { setOptions } = useECharts(chartRef as Ref<HTMLDivElement>)
  const trendChartRef = ref<HTMLDivElement | null>(null)
  const { setOptions: setTrendOptions } = useECharts(trendChartRef as Ref<HTMLDivElement>)

  const statsLoading = ref(false)
  const runningLoading = ref(false)
  const polling = ref(true)
  const health = ref<HealthResult | null>(null)
  const runningRows = ref<RunningRow[]>([])
  const samples = ref<SamplePoint[]>([])
  const selectedId = ref('')
  let timer: IntervalHandle | null = null

  /** 顶部统计卡数据，全部来自 GET /statistics/overview（契约 1.5） */
  const stats = reactive({
    datasourceTotal: 0,
    taskTotal: 0,
    runningInstances: 0,
    todayTotal: 0,
    todaySuccess: 0,
    todayFailed: 0,
    todayStopped: 0,
  })
  const trend = ref<StatisticsTrendItem[]>([])

  const progressColumns: TableColumn[] = [
    { title: '实例 ID', dataIndex: 'id', key: 'id', width: 120 },
    { title: '任务名称', dataIndex: 'taskName', key: 'taskName', width: 180, ellipsis: true },
    { title: '任务 ID', dataIndex: 'taskId', key: 'taskId', width: 120 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100 },
    { title: '进度', key: 'progress', width: 170 },
    { title: '已读/已写/总行数', key: 'rows', width: 220 },
    { title: '速率', key: 'rateRowsPerSec', width: 130 },
    { title: '当前位点', key: 'currentOffset', width: 240, ellipsis: true },
    { title: '开始时间', key: 'startedAt', width: 170 },
  ]

  /** 今日执行成功率，用于统计卡副标题 */
  const todaySuccessRate = computed(() => {
    if (!stats.todayTotal) return 0
    return Math.round((stats.todaySuccess / stats.todayTotal) * 100)
  })

  const statisticCards = computed(() => [
    {
      title: '数据源总数',
      value: stats.datasourceTotal,
      icon: 'ant-design:database-outlined',
      valueStyle: { color: '#722ed1' },
      hint: '来自 /datasources',
    },
    {
      title: '任务总数',
      value: stats.taskTotal,
      icon: 'ant-design:profile-outlined',
      valueStyle: { color: '#1890ff' },
      hint: '含定时与手动任务',
    },
    {
      title: '运行中实例',
      value: stats.runningInstances,
      icon: 'ant-design:loading-outlined',
      valueStyle: { color: '#13c2c2' },
      hint: '下方表格 3 秒轮询进度',
    },
    {
      title: '今日执行',
      value: stats.todayTotal,
      icon: 'ant-design:field-time-outlined',
      valueStyle: { color: '#faad14' },
      hint: `其中已停止 ${stats.todayStopped} 次`,
    },
    {
      title: '今日成功',
      value: stats.todaySuccess,
      icon: 'ant-design:check-circle-outlined',
      valueStyle: { color: '#52c41a' },
      hint: `成功率 ${todaySuccessRate.value}%`,
    },
    {
      title: '今日失败',
      value: stats.todayFailed,
      icon: 'ant-design:close-circle-outlined',
      valueStyle: { color: '#f5222d' },
      hint: '失败原因见运行日志页',
    },
  ])

  const healthTag = computed(() => {
    const data = unref(health)
    if (!data) return { text: '未知', color: 'default' }
    if (data.status === 'ok') {
      const mode = data.storage ? `（${data.storage === 'mysql' ? 'MySQL 持久化' : '内存 mock'}）` : data.mock ? '（mock）' : ''
      return { text: `${data.service}${mode}`, color: 'success' }
    }
    return { text: data.status || '异常', color: 'error' }
  })

  const selectedLabel = computed(() => {
    const row = unref(runningRows).find((item) => item.id === unref(selectedId))
    return row ? `${row.taskName || row.taskId} · ${row.id}` : ''
  })

  function getRowClassName(record: RunningRow) {
    return record.id === unref(selectedId) ? 'row-tracked' : ''
  }

  function customRow(record: RunningRow) {
    return {
      onClick: () => {
        selectedId.value = record.id
      },
    }
  }

  async function loadStats() {
    statsLoading.value = true
    try {
      const res = await getStatisticsOverviewApi()
      Object.assign(stats, {
        datasourceTotal: res?.datasourceTotal ?? 0,
        taskTotal: res?.taskTotal ?? 0,
        runningInstances: res?.runningInstances ?? 0,
        todayTotal: res?.todayTotal ?? 0,
        todaySuccess: res?.todaySuccess ?? 0,
        todayFailed: res?.todayFailed ?? 0,
        todayStopped: res?.todayStopped ?? 0,
      })
      trend.value = res?.recentTrend ?? []
      renderTrendChart()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '统计加载失败'))
    } finally {
      statsLoading.value = false
    }
  }

  /** 柱状（成功/失败）+ 折线（执行总数）组合图 */
  function renderTrendChart() {
    const list = unref(trend)
    if (!list.length) return
    setTrendOptions({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['成功', '失败', '执行总数'] },
      grid: { left: '1%', right: '1%', top: 50, bottom: 24, containLabel: true },
      xAxis: { type: 'category', data: list.map((item) => item.date) },
      yAxis: { type: 'value', name: '实例数', minInterval: 1 },
      series: [
        {
          name: '成功',
          type: 'bar',
          barMaxWidth: 26,
          itemStyle: { color: '#52c41a' },
          data: list.map((item) => Number(item.success || 0)),
        },
        {
          name: '失败',
          type: 'bar',
          barMaxWidth: 26,
          itemStyle: { color: '#f5222d' },
          data: list.map((item) => Number(item.failed || 0)),
        },
        {
          name: '执行总数',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          itemStyle: { color: '#1890ff' },
          data: list.map((item) => Number(item.success || 0) + Number(item.failed || 0)),
        },
      ],
    })
  }

  async function loadHealth() {
    try {
      health.value = await getHealthApi()
    } catch {
      health.value = { status: 'unreachable', service: 'databridge-admin' }
    }
  }

  /**
   * 运行中实例列表 + 每个任务的 /tasks/:id/progress 聚合（rateRowsPerSec 只在 progress 中返回）
   */
  async function loadRunning() {
    runningLoading.value = true
    try {
      const res = await getTaskInstanceListApi({ page: 1, size: 100, status: 'running' })
      const rows: RunningRow[] = (res?.items ?? []).map((item) => ({ ...item }))
      const details = await Promise.allSettled(
        rows.map((item) => (item.taskId ? getTaskProgressApi(item.taskId) : getPipelineStatusApi(item.pipelineId!))),
      )
      details.forEach((detail, index) => {
        if (detail.status !== 'fulfilled') return
        const progress = detail.value as TaskProgress
        rows[index] = {
          ...rows[index],
          progress: progress?.progress ?? rows[index].progress,
          readRows: progress?.readRows ?? rows[index].readRows,
          writeRows: progress?.writeRows ?? rows[index].writeRows,
          totalRows: progress?.totalRows ?? rows[index].totalRows,
          rateRowsPerSec: progress?.rateRowsPerSec ?? (progress as any)?.currentQps,
          currentOffset: progress?.currentOffset ?? (progress as any)?.cdcPosition ?? null,
          status: progress?.status || rows[index].status,
        }
      })
      runningRows.value = rows
      if (!unref(selectedId) && rows.length) {
        selectedId.value = rows[0].id
      }
      collectSample()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '运行中实例加载失败'))
    } finally {
      runningLoading.value = false
    }
  }

  function collectSample() {
    const rows = unref(runningRows)
    if (!rows.length) return
    const target = rows.find((item) => item.id === unref(selectedId)) || rows[0]
    selectedId.value = target.id
    samples.value = [
      ...unref(samples),
      {
        time: formatTimeAxis(Date.now()),
        progress: Number(target.progress || 0),
        readRows: Number(target.readRows || 0),
        rate: Number(target.rateRowsPerSec || 0),
      },
    ].slice(-60)
    renderChart()
  }

  function renderChart() {
    const points = unref(samples)
    setOptions({
      tooltip: { trigger: 'axis' },
      legend: { data: ['进度(%)', '已读行数', '速率(rows/s)'] },
      grid: { left: '1%', right: '1%', top: 50, bottom: 24, containLabel: true },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: points.map((item) => item.time),
      },
      yAxis: [
        { type: 'value', name: '进度 %', max: 100 },
        { type: 'value', name: '行数 / 速率' },
      ],
      series: [
        {
          name: '进度(%)',
          type: 'line',
          smooth: true,
          yAxisIndex: 0,
          data: points.map((item) => item.progress),
        },
        {
          name: '已读行数',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          data: points.map((item) => item.readRows),
        },
        {
          name: '速率(rows/s)',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          data: points.map((item) => item.rate),
        },
      ],
    })
  }

  async function handleRefresh() {
    await Promise.all([loadHealth(), loadStats(), loadRunning()])
  }

  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      loadRunning()
    }, POLL_INTERVAL)
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function handlePollingChange(checked: boolean) {
    polling.value = checked
    if (checked) startTimer()
    else stopTimer()
  }

  onMounted(async () => {
    await handleRefresh()
    if (unref(polling)) startTimer()
  })

  onUnmounted(() => {
    stopTimer()
  })
</script>
<style lang="less" scoped>
  .stat-hint {
    margin-top: 4px;
    min-height: 20px;
    color: #8c8c8c;
    font-size: 12px;
  }

  .offset-text {
    font-family: monospace;
  }

  :deep(.row-tracked) {
    td {
      background-color: rgba(24, 144, 255, 0.08);
    }
  }
</style>
