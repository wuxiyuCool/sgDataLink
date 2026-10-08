<template>
  <PageWrapper
    title="指标中心 · 任务管理"
    content="把指标物化到 ADS 汇总表：保存即组计划（配置错误挡在保存期），支持 preview 语句、手动执行、cron 调度与运行记录"
  >
    <GuideCard :guide="PAGE_GUIDES.task" />
    <Card :bordered="false" class="mb-3">
      <Form layout="inline" @finish="handleSearch">
        <FormItem label="关键字" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="任务名称"
            style="width: 200px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="[
              { label: '启用', value: 'online' },
              { label: '停用', value: 'offline' },
            ]"
            allow-clear
            placeholder="全部"
            style="width: 120px"
          />
        </FormItem>
        <FormItem label="最近结果" name="lastStatus">
          <Select
            v-model:value="query.lastStatus"
            :options="[
              { label: '空闲', value: 'idle' },
              { label: '运行中', value: 'running' },
              { label: '成功', value: 'success' },
              { label: '失败', value: 'failed' },
            ]"
            allow-clear
            placeholder="全部"
            style="width: 130px"
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
        <Button type="primary" @click="handleCreate">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新建任务
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        row-key="id"
        size="middle"
        :scroll="{ x: 1150 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <Tag :color="record.status === 'online' ? 'success' : 'default'">
              {{ record.status === 'online' ? '启用' : '停用' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'lastStatus'">
            <Tag :color="LAST_STATUS_COLORS[record.lastStatus || 'idle'] || 'default'">
              {{ LAST_STATUS_LABELS[record.lastStatus || 'idle'] }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'lastRunAt'">{{
            formatTime(record.lastRunAt)
          }}</template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button
                type="link"
                size="small"
                :loading="runningId === record.id"
                @click="handleRun(record)"
              >
                执行
              </Button>
              <Button type="link" size="small" @click="handleRuns(record)">记录</Button>
              <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
              <Popconfirm title="确认删除该任务？" @confirm="handleDelete(record)">
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <TaskModal @register="registerTaskModal" @success="reload" />

    <BasicModal
      v-bind="$attrs"
      :width="1040"
      centered
      canFullscreen
      :footer="null"
      @register="registerRunsModal"
    >
      <template #title>
        <span class="modal-title">
          <Icon icon="ion:time-outline" :size="18" />
          运行记录 · {{ runsTaskName }}
        </span>
      </template>
      <div class="runs-modal-root">
        <Table
          :columns="runColumns"
          :data-source="runs"
          :loading="runsLoading"
          :pagination="{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }"
          row-key="id"
          size="small"
          :row-class-name="(_: any, index: number) => (index % 2 === 1 ? 'striped-row' : '')"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'trigger'">
              <Tag :color="record.trigger === 'cron' ? 'purple' : 'blue'" :bordered="false">
                {{ record.trigger === 'cron' ? '定时' : '手动' }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag
                :color="
                  record.status === 'success'
                    ? 'success'
                    : record.status === 'failed'
                    ? 'error'
                    : 'processing'
                "
                :bordered="false"
              >
                {{ LAST_STATUS_LABELS[record.status] || record.status }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'createdAt'">{{
              formatTime(record.createdAt)
            }}</template>
            <template v-else-if="column.key === 'sql'">
              <Button type="link" size="small" @click="showSql(record)">查看 SQL</Button>
            </template>
          </template>
        </Table>
        <Collapse v-if="currentSql" ghost default-active-key="sql" class="mt-2 sql-collapse">
          <CollapsePanel key="sql" header="SQL 明细">
            <pre class="sql-block">{{ currentSql }}</pre>
          </CollapsePanel>
        </Collapse>
      </div>
    </BasicModal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'

  import {
    Button,
    Card,
    Collapse,
    Form,
    Input,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
  } from 'ant-design-vue'

  import {
    deleteMetricTaskApi,
    getMetricTaskRunsApi,
    getMetricTasksApi,
    runMetricTaskApi,
    type MetricTask,
    type MetricTaskRun,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModal } from '/@/components/Modal'
  import { PageWrapper } from '/@/components/Page'
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { usePagedFetch } from '../../databridge/hooks/usePagedFetch'
  import { formatTime } from '../data'
  import TaskModal from './TaskModal.vue'

  const FormItem = Form.Item
  const CollapsePanel = Collapse.Panel

  const { createMessage } = useMessage()
  const [registerTaskModal, { openModal: openTaskModal }] = useModal()

  const LAST_STATUS_LABELS: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    success: '成功',
    failed: '失败',
  }
  const LAST_STATUS_COLORS: Record<string, string> = {
    idle: 'default',
    running: 'processing',
    success: 'success',
    failed: 'error',
  }

  const query = reactive({
    keyword: undefined as string | undefined,
    status: undefined as string | undefined,
    lastStatus: undefined as string | undefined,
  })

  const columns = [
    { title: '任务名称', dataIndex: 'name', key: 'name', width: 180 },
    { title: '目标表', dataIndex: 'targetTable', key: 'targetTable', width: 200 },
    { title: '写模式', dataIndex: 'writeMode', key: 'writeMode', width: 90 },
    { title: 'Cron', dataIndex: 'scheduleCron', key: 'scheduleCron', width: 130 },
    { title: '状态', key: 'status', width: 80 },
    { title: '最近结果', key: 'lastStatus', width: 100 },
    { title: '最近执行', key: 'lastRunAt', width: 160 },
    { title: '操作', key: 'action', width: 220, fixed: 'right' as const },
  ]

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<MetricTask>(
    (params) =>
      getMetricTasksApi({
        page: params.page,
        size: params.size,
        keyword: query.keyword,
        status: query.status,
        lastStatus: query.lastStatus,
      }),
    query,
  )

  function handleSearch() {
    search()
  }

  function handleReset() {
    query.keyword = undefined
    query.status = undefined
    query.lastStatus = undefined
    resetFetch()
  }

  function handleCreate() {
    openTaskModal(true, { isUpdate: false })
  }

  function handleEdit(record: MetricTask) {
    openTaskModal(true, { record, isUpdate: true })
  }

  const runningId = ref('')

  async function handleRun(record: MetricTask) {
    runningId.value = record.id
    try {
      const result = await runMetricTaskApi(record.id)
      if (result.status === 'success') {
        createMessage.success(
          `执行成功，写入 ${result.writeRows ?? 0} 行（${result.statements ?? '-'} 段语句）`,
        )
      } else {
        createMessage.error(
          `执行${result.status === 'failed' ? '失败' : result.status}，查看运行记录`,
        )
      }
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '执行请求失败'))
    } finally {
      runningId.value = ''
    }
  }

  async function handleDelete(record: MetricTask) {
    try {
      await deleteMetricTaskApi(record.id)
      createMessage.success(`已删除任务【${record.name}】`)
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  const runsLoading = ref(false)
  const runs = ref<MetricTaskRun[]>([])
  const runsTaskName = ref('')
  const currentSql = ref('')

  const [registerRunsModal, { openModal: openRunsModal }] = useModal()

  const runColumns = [
    { title: '触发', dataIndex: 'trigger', key: 'trigger', width: 80 },
    { title: '状态', key: 'status', width: 90 },
    { title: '写入行', dataIndex: 'writeRows', key: 'writeRows', width: 80 },
    { title: '耗时(ms)', dataIndex: 'elapsedMs', key: 'elapsedMs', width: 90 },
    { title: '信息', dataIndex: 'message', key: 'message', ellipsis: true },
    { title: '时间', key: 'createdAt', width: 165 },
    { title: 'SQL', key: 'sql', width: 90 },
  ]

  async function handleRuns(record: MetricTask) {
    runsTaskName.value = record.name
    currentSql.value = ''
    openRunsModal(true)
    runsLoading.value = true
    try {
      const result = await getMetricTaskRunsApi(record.id, { page: 1, size: 50 })
      runs.value = result?.items || []
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '记录加载失败'))
    } finally {
      runsLoading.value = false
    }
  }

  function showSql(record: MetricTaskRun) {
    currentSql.value = record.sqlText || '(无)'
  }

  onMounted(search)
</script>

<style lang="less" scoped>
  .modal-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .sql-collapse {
    border-top: 1px dashed #e8e8e8;
  }

  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.7;
    background: #f6f8fa;
    border: 1px solid #eaecef;
    border-left: 3px solid #1677ff;
    padding: 10px 14px;
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
</style>
