<template>
  <PageWrapper
    title="数据管道"
    content="对标 FineDataLink 数据管道：整库/多表 CDC 实时镜像，只做搬运。运行中的管道每 3 秒轮询 GET /pipelines/:id/status 刷新 QPS、同步延迟与 CDC 位点"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline" @finish="handleSearch">
        <FormItem label="名称" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="管道名称关键字"
            style="width: 180px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="PIPELINE_STATUS_OPTIONS"
            allow-clear
            placeholder="全部状态"
            style="width: 140px"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" html-type="submit">查询</Button>
            <Button @click="handleReset">重置</Button>
          </Space>
        </FormItem>
      </Form>
    </Card>

    <Card :bordered="false">
      <div class="mb-3 flex items-center justify-between">
        <Space>
          <span class="text-gray-500">运行状态轮询(3s)</span>
          <Switch v-model:checked="polling" @change="handlePollingChange" />
          <Button size="small" @click="handlePollNow">
            <Icon icon="ant-design:sync-outlined" class="mr-1" />
            立即刷新指标
          </Button>
        </Space>
        <Button type="primary" @click="handleCreate">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新建管道
        </Button>
      </div>

      <Alert
        v-if="pollError"
        class="mb-3"
        type="warning"
        show-icon
        closable
        :message="`实时状态获取失败：${pollError}`"
        @close="pollError = ''"
      />

      <Table
        :columns="pipelineColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 2040 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'endpoints'">
            <span class="endpoint-text">
              {{ getEndpointLabel(record.sourceId, record.sourceName) }}
              <Icon icon="ant-design:arrow-right-outlined" class="mx-1" />
              {{ getEndpointLabel(record.targetId, record.targetName) }}
            </span>
          </template>
          <template v-else-if="column.key === 'syncObjects'">
            <Tooltip :title="(record.syncObjects || []).join('\n')">
              <span>{{ getSyncObjectsSummary(record.syncObjects) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'ddlPolicy'">
            <Tag>{{ DDL_POLICY_LABELS[record.ddlPolicy] || record.ddlPolicy || '-' }}</Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="getPipelineStatusColor(record.status)">
              {{ getPipelineStatusLabel(record.status) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'currentQps'">
            {{ isRunning(record) ? formatNumber(record.currentQps) : '-' }}
          </template>
          <template v-else-if="column.key === 'lagMs'">
            <span
              v-if="isRunning(record) && record.lagMs !== undefined && record.lagMs !== null"
              :class="isLagOverThreshold(record.lagMs) ? 'lag-danger' : 'lag-normal'"
            >
              {{ formatLag(record.lagMs) }}
            </span>
            <span v-else>-</span>
          </template>
          <template v-else-if="column.key === 'changeRows'">
            {{ isRunning(record) ? formatNumber(record.changeRows) : '-' }}
          </template>
          <template v-else-if="column.key === 'cdcPosition'">
            <span class="offset-text">{{ (isRunning(record) && record.cdcPosition) || '-' }}</span>
          </template>
          <template v-else-if="column.key === 'pollConfig'">
            <Tooltip
              :title="
                record.cdcPollColumn
                  ? `真实模式按 ${record.cdcPollColumn} 每 ${
                      record.pollIntervalSec ?? DEFAULT_POLL_INTERVAL_SEC
                    } 秒拉一轮增量`
                  : '未配置增量轮询列，引擎无法做真实增量拉取，本次执行按模拟处理'
              "
            >
              <span :class="record.cdcPollColumn ? '' : 'poll-missing'">{{
                getPollConfigSummary(record.cdcPollColumn, record.pollIntervalSec)
              }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'lastError'">
            <Tooltip v-if="record.lastError" :title="record.lastError">
              <span class="lag-danger">{{ record.lastError }}</span>
            </Tooltip>
            <span v-else>-</span>
          </template>
          <template v-else-if="column.key === 'updatedAt'">{{ formatTime(record.updatedAt) }}</template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Popconfirm
                title="确认启动该管道？启动后引擎以 cdc 模式持续捕获变更"
                ok-text="启动"
                cancel-text="取消"
                @confirm="handleStart(record)"
              >
                <Button
                  type="link"
                  size="small"
                  :loading="actionLoading === record.id"
                  :disabled="isRunning(record)"
                >
                  启动
                </Button>
              </Popconfirm>
              <Popconfirm
                title="确认停止该管道？停止后不再捕获新的变更事件"
                ok-text="停止"
                cancel-text="取消"
                @confirm="handleStop(record)"
              >
                <Button
                  type="link"
                  size="small"
                  :loading="actionLoading === record.id"
                  :disabled="!isRunning(record)"
                >
                  停止
                </Button>
              </Popconfirm>
              <Button
                type="link"
                size="small"
                :disabled="isRunning(record)"
                @click="handleEdit(record)"
              >
                编辑
              </Button>
              <Popconfirm
                title="确认删除该管道？运行中的管道不允许删除（后端返回 40003）"
                ok-text="删除"
                cancel-text="取消"
                @confirm="handleDelete(record)"
              >
                <Button type="link" size="small" danger :disabled="isRunning(record)">删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <PipelineModal @register="registerModal" @success="reload" />
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, onUnmounted, reactive, ref, unref } from 'vue'
  import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    Popconfirm,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useModal } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import {
    deletePipelineApi,
    getPipelineListApi,
    getPipelineStatusApi,
    startPipelineApi,
    stopPipelineApi,
  } from '/@/api/databridge/pipeline'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { Pipeline, PipelineStatusResult } from '/@/api/databridge/model/pipelineModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    DDL_POLICY_LABELS,
    PIPELINE_STATUS_OPTIONS,
    POLL_INTERVAL,
    formatLag,
    formatNumber,
    formatTime,
    getPipelineStatusColor,
    getPipelineStatusLabel,
    isLagOverThreshold,
  } from '../data'
  import { DEFAULT_POLL_INTERVAL_SEC, getPollConfigSummary, pipelineColumns } from './pipeline.data'
  import PipelineModal from './PipelineModal.vue'

  const FormItem = Form.Item

  const { createMessage, notification } = useMessage()
  const [registerModal, { openModal }] = useModal()

  const query = reactive({
    keyword: undefined as string | undefined,
    status: undefined as string | undefined,
  })

  const actionLoading = ref('')
  const polling = ref(true)
  const pollError = ref('')
  const datasourceNames = ref<Record<string, string>>({})
  let timer: IntervalHandle | null = null

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<Pipeline>((params) => getPipelineListApi(params), query)

  function isRunning(record: Pipeline) {
    return record.status === 'running'
  }

  function getEndpointLabel(id?: string, name?: string) {
    if (!id) return '-'
    return name || unref(datasourceNames)[id] || id
  }

  /** 同步对象列只展示前 2 张表，其余折叠为「等 N 张表」 */
  function getSyncObjectsSummary(objects?: string[]) {
    const list = objects ?? []
    if (!list.length) return '-'
    if (list.length <= 2) return list.join('、')
    return `${list.slice(0, 2).join('、')} 等 ${list.length} 张表`
  }

  async function loadDatasourceNames() {
    try {
      const list = await getAllDatasourcesApi()
      const map: Record<string, string> = {}
      list.forEach((item) => {
        if (item.id) map[item.id] = item.name
      })
      datasourceNames.value = map
    } catch {
      // 数据源名称仅用于展示，失败时回退为显示 id
    }
  }

  function applyStatus(row: Pipeline, status: PipelineStatusResult) {
    row.status = status.status || row.status
    row.currentQps = status.currentQps
    row.lagMs = status.lagMs
    row.changeRows = status.changeRows
    row.cdcPosition = status.cdcPosition
    row.runningInstanceId = status.instanceId ?? row.runningInstanceId
    row.statusAt = Date.now()
  }

  /**
   * 契约 1.7：running 行 3s 轮询 GET /pipelines/:id/status
   * 单个管道取数失败不影响其它行，只保留最后一条错误提示
   */
  async function pollRunningStatus() {
    const running = dataSource.value.filter((item) => isRunning(item))
    if (!running.length) {
      pollError.value = ''
      return
    }
    const results = await Promise.allSettled(
      running.map((item) => getPipelineStatusApi(item.id as string)),
    )
    let failed: string | null = null
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        applyStatus(running[index], result.value)
      } else {
        failed = getApiErrorMessage((result as PromiseRejectedResult).reason, '状态接口不可用')
      }
    })
    pollError.value = failed ?? ''
  }

  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      pollRunningStatus()
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

  function handlePollNow() {
    pollRunningStatus()
  }

  async function handleSearch() {
    await search()
    pollRunningStatus()
  }

  async function handleReset() {
    await resetFetch()
    pollRunningStatus()
  }

  function handleCreate() {
    openModal(true, { isUpdate: false })
  }

  function handleEdit(record: Pipeline) {
    openModal(true, { record, isUpdate: true })
  }

  async function handleStart(record: Pipeline) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      const result = await startPipelineApi(record.id)
      notification.success({
        message: '管道启动指令已下发',
        description: `【${record.name}】运行实例 instanceId：${result?.instanceId ?? '-'}`,
        duration: 5,
      })
      await reload()
      pollRunningStatus()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '启动失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleStop(record: Pipeline) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      await stopPipelineApi(record.id)
      createMessage.success(`管道【${record.name}】正在停止`)
      await reload()
      pollRunningStatus()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '停止失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleDelete(record: Pipeline) {
    if (!record.id) return
    try {
      await deletePipelineApi(record.id)
      createMessage.success(`已删除管道【${record.name}】`)
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(async () => {
    await search()
    loadDatasourceNames()
    pollRunningStatus()
    if (unref(polling)) startTimer()
  })

  onUnmounted(() => {
    stopTimer()
  })
</script>
<style lang="less" scoped>
  .offset-text,
  .endpoint-text {
    font-family: monospace;
  }

  .lag-normal {
    color: #52c41a;
  }

  /* 延迟超阈值（默认 5000ms）单元格标红 */
  .lag-danger {
    color: #cf1322;
    font-weight: 600;
  }

  /* 未配置增量轮询列：该管道无法真实增量拉取，弱化提示为待补齐 */
  .poll-missing {
    color: #fa8c16;
  }
</style>
