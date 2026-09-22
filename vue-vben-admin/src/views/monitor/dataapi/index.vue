<template>
  <PageWrapper
    title="服务监控"
    content="数据来源：顶部 4 卡与 7 日成功/错误堆叠柱来自 GET /statistics/overview 的 dataApiCallStats（30s 轮询，后端未下发时全部显示 '-'）；调用明细来自 GET /data-apis/calls（10s 轮询，支持 result / apiId / keyword 过滤，后端滚动保留最近 5000 条）。"
  >
    <template #headerContent>
      <MonitorToolbar
        v-model="autoRefresh"
        rule="统计卡 30s · 调用明细 10s"
        :updated="callsUpdatedAt"
        :hint="`统计 ${statsUpdatedAt || '-'} / 明细 ${
          callsUpdatedAt || '-'
        }（明细开关独立，可单独关闭）`"
        :loading="manualLoading"
        @refresh="handleRefreshAll"
      >
        <Tag>服务 {{ overview?.dataApiTotal ?? '-' }} 个</Tag>
        <Tag v-if="overview" color="success">已发布 {{ overview.publishedDataApis ?? 0 }} 个</Tag>
      </MonitorToolbar>
    </template>

    <div class="monitor-body">
      <!-- 1. 4 张调用统计卡 -->
      <ApiCallKpiCards
        class="mb-3"
        :stats="callStats"
        :loading="statsLoading"
        :error="statsError"
        @dismiss-error="statsError = ''"
      />

      <!-- 2. 7 日成功/错误堆叠柱 + 服务维度 TOP5 -->
      <Row :gutter="[16, 16]" class="mb-3">
        <Col :xs="24" :lg="14">
          <ApiCallTrendChart :trend="dayTrend" :loading="statsLoading" :error="statsError" />
        </Col>
        <Col :xs="24" :lg="10">
          <TopDataApiPanel :items="topDataApis" :loading="statsLoading" :error="statsError" />
        </Col>
      </Row>

      <!-- 3. 调用明细 -->
      <Card :bordered="false">
        <Alert
          v-if="callsError"
          class="mb-3"
          type="error"
          show-icon
          closable
          message="调用明细加载失败"
          :description="callsError"
          @close="callsError = ''"
        />

        <Tabs v-model:activeKey="resultTab" @change="handleTabChange">
          <!-- 过滤条放在 Tab 条右侧，表格只挂一份，避免三个 Tab 各建一张表 -->
          <template #rightExtra>
            <Space :size="8" wrap>
              <Select
                v-model:value="query.apiId"
                :options="apiOptions"
                :loading="apiOptionsLoading"
                allow-clear
                show-search
                option-filter-prop="label"
                placeholder="全部服务"
                style="width: 210px"
                @change="handleFilterChange"
              />
              <Input
                v-model:value="query.keyword"
                allow-clear
                placeholder="服务名 / 路径关键字"
                style="width: 190px"
                @press-enter="handleFilterChange"
              />
              <Button @click="handleFilterReset">重置</Button>
              <span class="poll-hint">自动刷新(10s)</span>
              <Switch
                :checked="effectiveCallsRefresh"
                size="small"
                @change="handleCallsRefreshChange"
              />
              <Button :loading="callsLoading" @click="loadCalls">
                <Icon icon="ant-design:reload-outlined" class="mr-1" />
                刷新明细
              </Button>
            </Space>
          </template>
          <TabPane v-for="tab in API_CALL_RESULT_TABS" :key="tab.key" :tab="tab.label" />
        </Tabs>

        <Table
          :columns="apiCallColumns"
          :data-source="calls"
          :loading="callsLoading"
          :pagination="pagination"
          :scroll="{ x: 1580, y: 420 }"
          row-key="id"
          size="small"
          :row-class-name="callRowClassName"
          @change="handleTableChange"
        >
          <template #emptyText>
            <Empty
              :description="
                callsError ? '调用明细暂不可用，详见上方错误提示' : DASH_EMPTY_TEXT.calls
              "
            />
          </template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'createdAt'">
              <span class="mono">{{ formatTime(record.createdAt) }}</span>
            </template>
            <template v-else-if="column.key === 'apiName'">
              <Tooltip :title="`apiId：${record.apiId || '-'}`">
                <span class="api-name">{{ record.apiName || record.apiId || '-' }}</span>
              </Tooltip>
            </template>
            <template v-else-if="column.key === 'path'">
              <Tooltip :title="`运行时端点：${record.method || 'GET'} /ds/${record.path || '-'}`">
                <span class="mono">/ds/{{ record.path || '-' }}</span>
              </Tooltip>
            </template>
            <template v-else-if="column.key === 'httpStatus'">
              <Tag :color="httpStatusColor(record.httpStatus)">{{ record.httpStatus ?? '-' }}</Tag>
            </template>
            <template v-else-if="column.key === 'bizCode'">
              <span :class="isCallFailed(record) ? 'code-error' : 'code-ok'">
                {{ record.bizCode ?? '-' }}
              </span>
            </template>
            <template v-else-if="column.key === 'latencyMs'">
              <span class="latency">{{ formatLag(record.latencyMs) }}</span>
            </template>
            <template v-else-if="column.key === 'ip'">
              <span class="mono">{{ record.ip || '-' }}</span>
            </template>
            <template v-else-if="column.key === 'query'">
              <Tooltip :title="record.query || '-'">
                <span class="mono query-text">{{ record.query || '-' }}</span>
              </Tooltip>
            </template>
            <template v-else-if="column.key === 'errorMsg'">
              <Tooltip :title="record.errorMsg || ''">
                <span :class="record.errorMsg ? 'error-msg' : 'muted'">
                  {{ record.errorMsg || '-' }}
                </span>
              </Tooltip>
            </template>
          </template>
        </Table>
      </Card>
    </div>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, onUnmounted, reactive, ref, unref, watch } from 'vue'
  import {
    Alert,
    Button,
    Card,
    Col,
    Empty,
    Input,
    Row,
    Select,
    Space,
    Switch,
    Table,
    Tabs,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { getStatisticsOverviewApi } from '/@/api/databridge/statistics'
  import type { DataApiCallStats, StatisticsOverview } from '/@/api/databridge/statistics'
  import { getApiCallsApi, getDataApiListApi } from '/@/api/databridge/dataapi'
  import type { DataApiCallItem } from '/@/api/databridge/model/dataapiModel'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { formatLag, formatTime, formatTimeAxis } from '/@/views/databridge/data'
  import {
    API_CALL_RESULT_TABS,
    CALLS_POLL_INTERVAL,
    DASH_EMPTY_TEXT,
    OVERVIEW_POLL_INTERVAL,
    apiCallColumns,
    isCallFailed,
  } from '../monitor.data'
  import type { ApiCallResultFilter } from '../monitor.data'
  import ApiCallKpiCards from '../components/ApiCallKpiCards.vue'
  import ApiCallTrendChart from '../components/ApiCallTrendChart.vue'
  import MonitorToolbar from '../components/MonitorToolbar.vue'
  import TopDataApiPanel from '../components/TopDataApiPanel.vue'

  const TabPane = Tabs.TabPane

  /* ------------------------------ 刷新控制 ------------------------------ */

  const autoRefresh = ref(true)
  /** 调用明细专属 10s 开关（受总开关约束） */
  const callsAutoRefresh = ref(true)
  const effectiveCallsRefresh = computed(() => unref(autoRefresh) && unref(callsAutoRefresh))

  const manualLoading = ref(false)
  const statsUpdatedAt = ref('')
  const callsUpdatedAt = ref('')

  /* ------------------------------ 统计概览区 ------------------------------ */

  const overview = ref<StatisticsOverview | null>(null)
  const statsLoading = ref(false)
  const statsError = ref('')

  const callStats = computed<DataApiCallStats | null>(
    () => overview.value?.dataApiCallStats ?? null,
  )
  const dayTrend = computed(() => callStats.value?.dayTrend ?? [])
  const topDataApis = computed(() => overview.value?.topDataApis ?? [])

  /* ------------------------------ 调用明细区 ------------------------------ */

  const resultTab = ref<ApiCallResultFilter>('all')
  const query = reactive({
    apiId: undefined as string | undefined,
    keyword: undefined as string | undefined,
  })
  const paging = reactive({ page: 1, size: 20 })

  const calls = ref<DataApiCallItem[]>([])
  const callsTotal = ref(0)
  const callsLoading = ref(false)
  const callsError = ref('')

  const apiOptions = ref<{ label: string; value: string }[]>([])
  const apiOptionsLoading = ref(false)

  const pagination = computed(() => ({
    current: paging.page,
    pageSize: paging.size,
    total: unref(callsTotal),
    showSizeChanger: true,
    showQuickJumper: true,
    pageSizeOptions: ['10', '20', '50', '100'],
    showTotal: (total: number) => `共 ${total} 条`,
  }))

  /** 明细区首屏 loading 给表格，轮询刷新保持静默 */
  async function loadCalls() {
    if (!unref(calls).length) callsLoading.value = true
    try {
      const res = await getApiCallsApi({
        page: paging.page,
        size: paging.size,
        apiId: query.apiId,
        keyword: query.keyword,
        // 'all' 只表达「不按结果过滤」，不能当 result 值发给后端
        result: resultTab.value === 'all' ? undefined : resultTab.value,
      })
      calls.value = res?.items ?? []
      callsTotal.value = Number(res?.total ?? 0)
      callsError.value = ''
      callsUpdatedAt.value = formatTimeAxis(Date.now())
    } catch (error: unknown) {
      calls.value = []
      callsTotal.value = 0
      callsError.value = getApiErrorMessage(
        error,
        '调用明细加载失败（后端 /data-apis/calls 未交付时预期为 404）',
      )
    } finally {
      callsLoading.value = false
    }
  }

  async function loadStats() {
    statsLoading.value = true
    try {
      const res = await getStatisticsOverviewApi()
      overview.value = res ?? null
      statsError.value = ''
      statsUpdatedAt.value = formatTimeAxis(Date.now())
    } catch (error: unknown) {
      statsError.value = getApiErrorMessage(error, '统计概览加载失败')
    } finally {
      statsLoading.value = false
    }
  }

  /** apiId 下拉只列已发布服务：未发布的路径没有运行时端点，不可能产生调用 */
  async function loadApiOptions() {
    apiOptionsLoading.value = true
    try {
      const res = await getDataApiListApi({ page: 1, size: 200, status: 'published' })
      apiOptions.value = (res?.items ?? []).map((item) => ({
        label: `${item.name}（/ds/${item.path}）`,
        value: String(item.id),
      }))
    } catch {
      // 下拉只是过滤器，失败时留空，不影响按 result / keyword 查看明细
      apiOptions.value = []
    } finally {
      apiOptionsLoading.value = false
    }
  }

  function httpStatusColor(status?: number | string | null) {
    const value = Number(status)
    if (Number.isNaN(value)) return 'default'
    if (value >= 500) return 'error'
    if (value >= 400) return 'warning'
    return 'success'
  }

  function callRowClassName(record: DataApiCallItem) {
    return isCallFailed(record) ? 'call-row-error' : ''
  }

  function handleTabChange(key: ApiCallResultFilter) {
    resultTab.value = key
    paging.page = 1
    loadCalls()
  }

  function handleFilterChange() {
    paging.page = 1
    loadCalls()
  }

  function handleFilterReset() {
    query.apiId = undefined
    query.keyword = undefined
    resultTab.value = 'all'
    paging.page = 1
    loadCalls()
  }

  function handleTableChange(paginationState: any) {
    paging.page = paginationState?.current ?? paging.page
    paging.size = paginationState?.pageSize ?? paging.size
    loadCalls()
  }

  function handleCallsRefreshChange(checked: boolean) {
    callsAutoRefresh.value = checked
    if (checked) autoRefresh.value = true
  }

  async function handleRefreshAll() {
    manualLoading.value = true
    try {
      await Promise.allSettled([loadStats(), loadCalls()])
    } finally {
      manualLoading.value = false
    }
  }

  /* ------------------------------ 定时器 ------------------------------ */

  let statsTimer: IntervalHandle | null = null
  let callsTimer: IntervalHandle | null = null

  function clearTimers() {
    if (statsTimer) {
      clearInterval(statsTimer)
      statsTimer = null
    }
    if (callsTimer) {
      clearInterval(callsTimer)
      callsTimer = null
    }
  }

  /** 30s 统计（卡片+趋势） / 10s 调用明细 */
  function syncTimers() {
    clearTimers()
    if (!unref(autoRefresh)) return
    statsTimer = setInterval(loadStats, OVERVIEW_POLL_INTERVAL)
    if (unref(callsAutoRefresh)) callsTimer = setInterval(loadCalls, CALLS_POLL_INTERVAL)
  }

  watch([autoRefresh, callsAutoRefresh], syncTimers)

  onMounted(async () => {
    await Promise.allSettled([loadStats(), loadCalls(), loadApiOptions()])
    syncTimers()
  })

  onUnmounted(clearTimers)
</script>

<style lang="less" scoped>
  .monitor-body {
    width: 100%;
  }

  .mono {
    font-family: monospace;
  }

  .api-name {
    font-weight: 500;
  }

  .poll-hint {
    color: #8c8c8c;
    font-size: 12px;
  }

  .latency {
    font-variant-numeric: tabular-nums;
  }

  .query-text {
    display: inline-block;
    max-width: 220px;
    overflow: hidden;
    white-space: nowrap;
    vertical-align: bottom;
    text-overflow: ellipsis;
  }

  .code-error {
    color: #cf1322;
    font-weight: 600;
  }

  .code-ok {
    color: #8c8c8c;
  }

  .muted {
    color: #bfbfbf;
  }

  /* errorMsg 红字：与 bizCode/HTTP 的告警色一致 */
  .error-msg {
    color: #cf1322;
  }

  /* 错误调用整行浅红底，与运行日志页的 ERROR 行同一套语义色 */
  :deep(.call-row-error) {
    td {
      background-color: #fff1f0;
    }
  }
</style>
