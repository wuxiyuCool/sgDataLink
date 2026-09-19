<template>
  <PageWrapper
    title="数据开发"
    content="对标 FineDataLink 数据开发画布（ETL 编排）：以「输入 → 转换 → 输出」的节点流保存画布 JSON，run 时由引擎按全量模式模拟执行"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline" @finish="handleSearch">
        <FormItem label="名称" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="画布名称关键字"
            style="width: 180px"
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
            新建画布
          </Button>
        </Space>
      </div>

      <Table
        :columns="dataflowColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1720 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'graphSummary'">
            {{ (record.nodes || []).length }} / {{ (record.edges || []).length }}
          </template>
          <template v-else-if="column.key === 'lineage'">
            <Tooltip :title="getFlowLineageText(record.nodes)">
              <span class="offset-text">{{ getFlowLineageText(record.nodes) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'nodeTypes'">
            <Tooltip :title="getFlowNodeTypeSummary(record.nodes)">
              <span>{{ getFlowNodeTypeSummary(record.nodes) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'scheduleCron'">
            <Tooltip v-if="record.scheduleCron" :title="getScheduleTip(record)">
              <span class="offset-text">{{ record.scheduleCron }}</span>
            </Tooltip>
            <Tag v-else>手动</Tag>
          </template>
          <template v-else-if="column.key === 'lastStatus'">
            <Tag :color="getTaskStatusColor(record.lastStatus)">
              {{ getTaskStatusLabel(record.lastStatus) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'progress'">
            <Progress
              :percent="Number(record.progress || 0)"
              size="small"
              :status="getProgressStatus(record.lastStatus)"
            />
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            {{ formatTime(record.updatedAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button type="link" size="small" @click="goCanvas(record)">画布编辑</Button>
              <Popconfirm
                title="确认运行该画布？引擎将按首尾输入/输出节点模拟一次同步"
                ok-text="运行"
                cancel-text="取消"
                @confirm="handleRun(record)"
              >
                <Button
                  type="link"
                  size="small"
                  :loading="actionLoading === record.id"
                  :disabled="isRunning(record)"
                >
                  运行
                </Button>
              </Popconfirm>
              <Popconfirm
                title="确认停止该画布当前运行实例？"
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
              <Button type="link" size="small" @click="openProgress(record)">进度</Button>
              <Popconfirm
                title="确认删除该数据开发画布？运行中的画布不允许删除（后端返回 40003）"
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

    <Modal
      v-model:visible="createVisible"
      :confirm-loading="creating"
      title="新建数据开发画布"
      :mask-closable="false"
      ok-text="创建并进入画布"
      @ok="handleCreateSubmit"
    >
      <Form ref="createFormRef" :model="createForm" :rules="createRules">
        <FormItem label="画布名称" name="name" :label-col="{ span: 5 }" :wrapper-col="{ span: 18 }">
          <Input v-model:value="createForm.name" placeholder="例如：订单宽表加工" />
        </FormItem>
        <FormItem
          label="调度表达式"
          name="scheduleCron"
          :label-col="{ span: 5 }"
          :wrapper-col="{ span: 18 }"
          extra="Quartz 风格 6 位 cron，留空表示仅手动触发"
        >
          <Input v-model:value="createForm.scheduleCron" allow-clear placeholder="例如：0 0 3 * * ?" />
        </FormItem>
        <FormItem label="是否启用" name="enabled" :label-col="{ span: 5 }" :wrapper-col="{ span: 18 }">
          <Switch v-model:checked="createForm.enabled" />
        </FormItem>
      </Form>
      <Alert
        type="info"
        show-icon
        message="创建时会预置「数据输入 → 数据输出」两个节点，进入画布后补齐数据源与表名即可保存运行。"
      />
    </Modal>

    <RunProgressDrawer
      v-model:visible="progressVisible"
      :dataflow-id="progressId"
      :dataflow-name="progressName"
      :tick="progressTick"
    />
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'
  import { useRouter } from 'vue-router'
  import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    Modal,
    Popconfirm,
    Progress,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import {
    createDataflowApi,
    deleteDataflowApi,
    getDataflowListApi,
    getDataflowProgressApi,
    runDataflowApi,
    stopDataflowApi,
  } from '/@/api/databridge/dataflow'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { Dataflow } from '/@/api/databridge/model/dataflowModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    TASK_STATUS_OPTIONS,
    formatTime,
    getProgressStatus,
    getTaskStatusColor,
    getTaskStatusLabel,
    pickDataflowPayload,
  } from '../data'
  import { dataflowColumns, getFlowLineageText, getFlowNodeTypeSummary } from './dataflow.data'
  import { createSeedGraph } from './flowGraph'
  import RunProgressDrawer from './components/RunProgressDrawer.vue'

  const FormItem = Form.Item

  const router = useRouter()
  const { createMessage, notification } = useMessage()

  const query = reactive({
    keyword: undefined as string | undefined,
    lastStatus: undefined as string | undefined,
  })

  const actionLoading = ref('')
  const createVisible = ref(false)
  const creating = ref(false)
  const createFormRef = ref()
  const createForm = reactive({
    name: '',
    scheduleCron: '',
    enabled: true,
  })
  const createRules = {
    name: [{ required: true, message: '请输入画布名称', trigger: 'blur' }],
  }

  const progressVisible = ref(false)
  const progressId = ref('')
  const progressName = ref('')
  const progressTick = ref(0)

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<Dataflow>((params) => getDataflowListApi(params), query)

  function isRunning(record: Dataflow) {
    return record.lastStatus === 'running'
  }

  function getScheduleTip(record: Dataflow) {
    return (
      `定时调度：${record.scheduleCron}；失败重试 ${record.retryCount ?? 0} 次，` +
      `间隔 ${record.retryIntervalSec ?? 0} 秒`
    )
  }

  /** 运行中的画布用 GET /dataflows/:id/progress 聚合进度（后端列表对象不含 progress） */
  async function fillRunningProgress() {
    const running = dataSource.value.filter((item) => isRunning(item))
    if (!running.length) return
    const results = await Promise.allSettled(
      running.map((item) => getDataflowProgressApi(item.id as string)),
    )
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return
      const row = running[index]
      row.progress = result.value.progress
      row.runningInstanceId = result.value.instanceId ?? undefined
    })
  }

  async function handleSearch() {
    await search()
    fillRunningProgress()
  }

  async function handleReset() {
    await resetFetch()
    fillRunningProgress()
  }

  async function handleRefreshProgress() {
    await reload()
    fillRunningProgress()
  }

  function handleCreate() {
    createForm.name = ''
    createForm.scheduleCron = ''
    createForm.enabled = true
    createVisible.value = true
  }

  async function handleCreateSubmit() {
    if (createFormRef.value) {
      try {
        await createFormRef.value.validate()
      } catch {
        return
      }
    }
    creating.value = true
    try {
      const { nodes, edges } = createSeedGraph()
      const created = await createDataflowApi(
        pickDataflowPayload({
          name: createForm.name,
          nodes,
          edges,
          scheduleCron: String(createForm.scheduleCron || '').trim() || null,
          retryCount: 0,
          retryIntervalSec: 60,
          enabled: createForm.enabled,
        }),
      )
      createMessage.success('画布已创建，正在进入编辑器')
      createVisible.value = false
      await reload()
      const id = created?.id
      if (id) router.push({ path: '/databridge/dataflow/canvas', query: { id } })
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '创建失败'))
    } finally {
      creating.value = false
    }
  }

  function goCanvas(record: Dataflow) {
    router.push({ path: '/databridge/dataflow/canvas', query: { id: record.id } })
  }

  function openProgress(record: Dataflow) {
    progressId.value = record.id as string
    progressName.value = record.name
    progressTick.value += 1
    progressVisible.value = true
  }

  async function handleRun(record: Dataflow) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      const result = await runDataflowApi(record.id)
      notification.success({
        message: '画布运行已启动',
        description: `【${record.name}】运行实例 instanceId：${result?.instanceId ?? '-'}`,
        duration: 5,
      })
      await reload()
      fillRunningProgress()
      openProgress(record)
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '运行失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleStop(record: Dataflow) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      await stopDataflowApi(record.id)
      createMessage.success(`画布【${record.name}】正在停止`)
      await reload()
      fillRunningProgress()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '停止失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleDelete(record: Dataflow) {
    if (!record.id) return
    try {
      await deleteDataflowApi(record.id)
      createMessage.success(`已删除画布【${record.name}】`)
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(async () => {
    await search()
    fillRunningProgress()
  })
</script>
<style lang="less" scoped>
  .offset-text {
    font-family: monospace;
  }
</style>
