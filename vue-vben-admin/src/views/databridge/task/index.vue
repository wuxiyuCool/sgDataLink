<template>
  <PageWrapper
    title="同步任务管理"
    content="创建全量/增量同步任务，支持启动、停止、调度配置（cron + 失败重试）与字段映射转换；「触发方式」列取最近一次运行实例的 trigger（manual/cron/retry），最近状态旁的「模拟」Tag 表示该次执行未做真实读写（契约 4.1）；运行中的任务禁止编辑与删除（后端返回 40003）"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline" @finish="handleSearch">
        <FormItem label="名称" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="任务名称关键字"
            style="width: 180px"
          />
        </FormItem>
        <FormItem label="同步模式" name="syncMode">
          <Select
            v-model:value="query.syncMode"
            :options="SYNC_MODE_OPTIONS"
            allow-clear
            placeholder="全部模式"
            style="width: 140px"
          />
        </FormItem>
        <FormItem label="最近状态" name="lastStatus">
          <Select
            v-model:value="query.lastStatus"
            :options="TASK_STATUS_OPTIONS"
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
      <div class="mb-3 flex justify-end">
        <Space>
          <Button @click="handleRefreshProgress">
            <Icon icon="ant-design:sync-outlined" class="mr-1" />
            刷新进度
          </Button>
          <Button type="primary" @click="handleCreate">
            <Icon icon="ant-design:plus-outlined" class="mr-1" />
            新建任务
          </Button>
        </Space>
      </div>

      <Table
        :columns="taskColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1910 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record, text }">
          <template v-if="column.key === 'syncMode'">
            <Tag :color="SYNC_MODE_TAG_COLORS[record.syncMode] || 'default'">
              {{ getSyncModeLabel(record.syncMode) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'incrementalColumn'">
            {{ text || '-' }}
          </template>
          <template v-else-if="column.key === 'batchWrite'">
            {{ formatNumber(record.batchSize) }} / {{ record.writeMode || '-' }}
          </template>
          <template v-else-if="column.key === 'scheduleCron'">
            <Tooltip v-if="record.scheduleCron" :title="getScheduleTip(record)">
              <span class="cron-text">{{ record.scheduleCron }}</span>
            </Tooltip>
            <Tag v-else>手动</Tag>
          </template>
          <template v-else-if="column.key === 'lastStatus'">
            <Space :size="4">
              <Tag :color="getTaskStatusColor(record.lastStatus)">
                {{ getTaskStatusLabel(record.lastStatus) }}
              </Tag>
              <!-- 列宽有限，真实执行不加标识，只把「模拟」这一例外标出来（契约 4.1） -->
              <Tooltip v-if="isSimulateExec(record.latestExecMode)" :title="EXEC_MODE_SIMULATE_TIP">
                <Tag :color="getExecModeColor(record.latestExecMode)">
                  {{ getExecModeLabel(record.latestExecMode) }}
                </Tag>
              </Tooltip>
            </Space>
          </template>
          <template v-else-if="column.key === 'trigger'">
            <Tooltip
              v-if="record.latestTrigger"
              :title="`最近一次运行实例的触发方式（${record.latestTrigger}）`"
            >
              <Tag :color="getTriggerColor(record.latestTrigger)">
                {{ getTriggerLabel(record.latestTrigger) }}
              </Tag>
            </Tooltip>
            <span v-else>-</span>
          </template>
          <template v-else-if="column.key === 'progress'">
            <Progress
              :percent="Number(record.progress || 0)"
              size="small"
              :status="getProgressStatus(record.lastStatus)"
            />
          </template>
          <template v-else-if="column.key === 'lastRunAt'">{{ formatTime(text) }}</template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Popconfirm
                title="确认启动该任务？启动后引擎会创建新的运行实例"
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
                title="确认停止该任务当前运行实例？"
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
              <Button type="link" size="small" @click="goMapping(record)">映射</Button>
              <Button type="link" size="small" @click="goLog(record)">日志</Button>
              <Button
                type="link"
                size="small"
                :disabled="isRunning(record)"
                @click="handleEdit(record)"
              >
                编辑
              </Button>
              <Popconfirm
                title="确认删除该任务？运行中任务不允许删除"
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

    <TaskModal @register="registerModal" @success="reload" />
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import {
    Button,
    Card,
    Form,
    Input,
    Popconfirm,
    Progress,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useModal } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import {
    deleteTaskApi,
    getTaskListApi,
    getTaskProgressApi,
    startTaskApi,
    stopTaskApi,
  } from '/@/api/databridge/task'
  import { getTaskInstanceListApi } from '/@/api/databridge/taskInstance'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { ExecMode, InstanceTrigger } from '/@/api/databridge/model/commonModel'
  import type { Task } from '/@/api/databridge/model/taskModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    EXEC_MODE_SIMULATE_TIP,
    SYNC_MODE_OPTIONS,
    SYNC_MODE_TAG_COLORS,
    TASK_STATUS_OPTIONS,
    formatNumber,
    formatTime,
    getExecModeColor,
    getExecModeLabel,
    getProgressStatus,
    getSyncModeLabel,
    getTaskStatusColor,
    getTaskStatusLabel,
    getTriggerColor,
    getTriggerLabel,
    isSimulateExec,
  } from '../data'
  import { taskColumns } from './task.data'
  import TaskModal from './TaskModal.vue'

  const FormItem = Form.Item

  const router = useRouter()
  const { createMessage, notification } = useMessage()
  const [registerModal, { openModal }] = useModal()

  const query = reactive({
    keyword: undefined as string | undefined,
    syncMode: undefined as string | undefined,
    lastStatus: undefined as string | undefined,
  })

  const actionLoading = ref('')

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<Task>((params) => getTaskListApi(params), query)

  function isRunning(record: Task) {
    return record.lastStatus === 'running'
  }

  /** 调度列悬浮提示：cron + 重试策略（Mock 阶段仅保存展示，不触发实际调度） */
  function getScheduleTip(record: Task) {
    return (
      `定时调度：${record.scheduleCron}；失败重试 ${record.retryCount ?? 0} 次，` +
      `间隔 ${record.retryIntervalSec ?? 0} 秒（Mock 阶段仅保存，不触发实际调度）`
    )
  }

  /**
   * 任务对象本身不含 progress，运行中的行通过 GET /tasks/:id/progress 聚合补充
   */
  async function fillRunningProgress() {
    const running = dataSource.value.filter((item) => isRunning(item))
    if (!running.length) return
    const results = await Promise.allSettled(
      running.map((item) => getTaskProgressApi(item.id as string)),
    )
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return
      const row = running[index]
      row.progress = result.value.progress
      row.runningInstanceId = result.value.instanceId
    })
  }

  /**
   * 「触发方式 / 执行模式」增强列（契约 1.6、4.1）：任务列表接口既不含 trigger 也不含实例
   * execMode，这里用一次 GET /task-instances 拉最近 200 条实例，按 taskId 取第一条（最新）
   * 聚合两列，避免逐行请求；取不到时触发方式显示 '-'、不出现「模拟」标识，不影响列表主流程。
   */
  async function fillLatestInstance() {
    if (!dataSource.value.length) return
    try {
      const res = await getTaskInstanceListApi({
        page: 1,
        size: 200,
        sort: 'startedAt:desc',
      })
      const latest = new Map<string, { trigger: InstanceTrigger; execMode?: ExecMode }>()
      ;(res?.items ?? []).forEach((item) => {
        if (!item.taskId || latest.has(item.taskId)) return
        latest.set(item.taskId, {
          trigger: (item.trigger ?? 'manual') as InstanceTrigger,
          execMode: item.execMode,
        })
      })
      dataSource.value.forEach((row) => {
        const latestInstance = row.id ? latest.get(row.id) : undefined
        if (!latestInstance) return
        row.latestTrigger = latestInstance.trigger
        if (latestInstance.execMode) row.latestExecMode = latestInstance.execMode
      })
    } catch {
      // 两列都是附加信息，失败时静默保留 '-'/无标识
    }
  }

  async function loadList() {
    await search()
    fillRunningProgress()
    fillLatestInstance()
  }

  async function handleSearch() {
    await search()
    fillRunningProgress()
    fillLatestInstance()
  }

  async function handleReset() {
    await resetFetch()
    fillRunningProgress()
    fillLatestInstance()
  }

  async function handleRefreshProgress() {
    await reload()
    fillRunningProgress()
    fillLatestInstance()
  }

  function handleCreate() {
    openModal(true, { isUpdate: false })
  }

  function handleEdit(record: Task) {
    openModal(true, { record, isUpdate: true })
  }

  function goMapping(record: Task) {
    router.push({ path: '/databridge/mapping', query: { taskId: record.id } })
  }

  function goLog(record: Task) {
    router.push({ path: '/databridge/log', query: { taskId: record.id } })
  }

  async function handleStart(record: Task) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      const result = await startTaskApi(record.id)
      notification.success({
        message: '启动指令已下发',
        description: `任务【${record.name}】运行实例 instanceId：${result?.instanceId ?? '-'}`,
        duration: 5,
      })
      await reload()
      fillRunningProgress()
      fillLatestInstance()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '启动失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleStop(record: Task) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      const result = await stopTaskApi(record.id)
      createMessage.success(`停止指令已下发，实例 ${result?.instanceId ?? record.id} 正在停止`)
      await reload()
      fillRunningProgress()
      fillLatestInstance()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '停止失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleDelete(record: Task) {
    if (!record.id) return
    try {
      await deleteTaskApi(record.id)
      createMessage.success(`已删除任务【${record.name}】`)
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(() => {
    loadList()
  })
</script>
<style lang="less" scoped>
  .cron-text {
    font-family: monospace;
  }
</style>
