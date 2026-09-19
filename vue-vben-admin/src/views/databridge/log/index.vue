<template>
  <PageWrapper
    title="运行日志"
    content="按任务/运行实例查看引擎回报日志，支持级别过滤与 3 秒轮询；ERROR 行红色高亮"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline">
        <FormItem label="任务">
          <Select
            v-model:value="queryTaskId"
            :options="taskOptions"
            :loading="optionLoading"
            allow-clear
            show-search
            option-filter-prop="label"
            placeholder="全部任务"
            style="width: 260px"
            @change="handleTaskChange"
          />
        </FormItem>
        <FormItem label="运行实例">
          <Select
            v-model:value="instanceId"
            :options="instanceOptions"
            :loading="instanceLoading"
            show-search
            option-filter-prop="label"
            placeholder="请选择实例"
            style="width: 300px"
            @change="handleInstanceChange"
          />
        </FormItem>
        <FormItem label="级别" name="level">
          <Select
            v-model:value="query.level"
            :options="LOG_LEVEL_OPTIONS"
            allow-clear
            placeholder="全部级别"
            style="width: 130px"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" @click="handleSearch">查询</Button>
            <Button @click="handleReset">重置</Button>
            <span class="ml-2 text-gray-500">3s 轮询</span>
            <Switch v-model:checked="polling" @change="handlePollingChange" />
          </Space>
        </FormItem>
      </Form>
    </Card>

    <Card :bordered="false" class="mb-3" title="实例日志">
      <Table
        :columns="logColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1100, y: 460 }"
        row-key="id"
        size="small"
        :row-class-name="logRowClassName"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record, text }">
          <template v-if="column.key === 'level'">
            <Tag :color="LOG_LEVEL_TAG_COLORS[record.level] || 'default'">{{ record.level }}</Tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ formatTime(text) }}</template>
          <template v-else-if="column.key === 'message'">
            <span class="log-message">{{ text || '-' }}</span>
          </template>
          <template v-else-if="column.key === 'instanceId'">{{ text || '-' }}</template>
          <template v-else-if="column.key === 'taskId'">{{ text || '-' }}</template>
        </template>
      </Table>
    </Card>

    <Card :bordered="false" title="位点（offsets）">
      <Table
        :columns="offsetColumns"
        :data-source="offsets"
        :loading="offsetLoading"
        :pagination="false"
        row-key="id"
        size="small"
        :scroll="{ y: 240 }"
      >
        <template #bodyCell="{ column, text }">
          <template v-if="column.key === 'updatedAt'">{{ formatTime(text) }}</template>
          <template v-else-if="column.key === 'offsetValue'">
            <span class="log-message">{{ text || '-' }}</span>
          </template>
        </template>
      </Table>
    </Card>
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, onUnmounted, reactive, ref, unref } from 'vue'
  import { useRoute } from 'vue-router'
  import { Button, Card, Form, Select, Space, Switch, Table, Tag } from 'ant-design-vue'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllTasksApi } from '/@/api/databridge/task'
  import {
    getTaskInstanceListApi,
    getTaskInstanceLogsApi,
    getTaskInstanceOffsetsApi,
  } from '/@/api/databridge/taskInstance'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { TaskLog, TaskOffset } from '/@/api/databridge/model/taskInstanceModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import { LOG_LEVEL_OPTIONS, LOG_LEVEL_TAG_COLORS, POLL_INTERVAL, formatTime } from '../data'
  import { logColumns, offsetColumns } from './log.data'

  const FormItem = Form.Item

  const route = useRoute()
  const { createMessage } = useMessage()

  const optionLoading = ref(false)
  const instanceLoading = ref(false)
  const offsetLoading = ref(false)
  const polling = ref(false)
  const taskOptions = ref<{ label: string; value: string }[]>([])
  const instanceOptions = ref<{ label: string; value: string }[]>([])
  const offsets = ref<TaskOffset[]>([])
  const queryTaskId = ref<string | undefined>(undefined)
  const instanceId = ref<string>('')
  let timer: IntervalHandle | null = null

  const query = reactive({ level: undefined as string | undefined })

  const {
    loading,
    dataSource,
    getPagination,
    search,
    fetch,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<TaskLog>(
    (params) =>
      instanceId.value
        ? getTaskInstanceLogsApi(instanceId.value, params)
        : Promise.resolve({ items: [], total: 0 }),
    query,
  )

  function logRowClassName(record: TaskLog) {
    return record.level === 'ERROR' ? 'log-row-error' : ''
  }

  async function loadTaskOptions() {
    optionLoading.value = true
    try {
      const list = await getAllTasksApi()
      taskOptions.value = list.map((item) => ({
        label: `${item.name}（${item.id}）`,
        value: item.id as string,
      }))
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '任务列表加载失败'))
    } finally {
      optionLoading.value = false
    }
  }

  async function loadInstanceOptions(taskId?: string, autoSelect = true) {
    instanceLoading.value = true
    try {
      const res = await getTaskInstanceListApi({ page: 1, size: 100, taskId })
      const items = res?.items ?? []
      instanceOptions.value = items.map((item) => ({
        label: `${item.taskName || item.taskId} · ${item.id}（${item.status}）`,
        value: item.id,
      }))
      if (autoSelect) {
        const stillExists = items.some((item) => item.id === unref(instanceId))
        if (!stillExists) {
          instanceId.value = items.length ? items[0].id : ''
        }
      }
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '实例列表加载失败'))
    } finally {
      instanceLoading.value = false
    }
  }

  async function loadOffsets() {
    if (!unref(instanceId)) {
      offsets.value = []
      return
    }
    offsetLoading.value = true
    try {
      const res = await getTaskInstanceOffsetsApi(instanceId.value, { page: 1, size: 50 })
      offsets.value = res?.items ?? []
    } catch (error: any) {
      offsets.value = []
      createMessage.error(getApiErrorMessage(error, '位点加载失败'))
    } finally {
      offsetLoading.value = false
    }
  }

  async function handleSearch() {
    if (!unref(instanceId)) {
      createMessage.warning('请先选择运行实例')
      return
    }
    await search()
    loadOffsets()
  }

  function handleReset() {
    query.level = undefined
    resetFetch()
  }

  async function handleTaskChange(value?: string) {
    queryTaskId.value = value
    instanceId.value = ''
    await loadInstanceOptions(value)
    if (unref(instanceId)) handleInstanceChange()
  }

  function handleInstanceChange() {
    search()
    loadOffsets()
  }

  function startTimer() {
    stopTimer()
    timer = setInterval(() => {
      if (!unref(instanceId)) return
      fetch()
      loadOffsets()
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
    const taskId = (route.query.taskId as string) || undefined
    queryTaskId.value = taskId
    await loadTaskOptions()
    await loadInstanceOptions(taskId)
    if (unref(instanceId)) {
      await search()
      loadOffsets()
    }
  })

  onUnmounted(() => {
    stopTimer()
  })
</script>
<style lang="less" scoped>
  .log-message {
    font-family: monospace;
  }

  :deep(.log-row-error) {
    td {
      color: #cf1322;
      background-color: #fff1f0;
    }
  }
</style>
