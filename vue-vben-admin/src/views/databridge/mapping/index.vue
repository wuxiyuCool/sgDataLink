<template>
  <PageWrapper
    title="字段映射配置"
    content="选择任务后编辑该任务的 fieldMappings；保存时通过 PUT /tasks/:id 携带完整任务对象"
  >
    <Card :bordered="false" class="mb-3" title="选择任务">
      <Form layout="inline">
        <FormItem label="同步任务">
          <Select
            v-model:value="currentTaskId"
            :options="taskOptions"
            :loading="taskLoading"
            show-search
            option-filter-prop="label"
            placeholder="请选择需要配置映射的任务"
            style="width: 320px"
            @change="handleTaskChange"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button :disabled="!currentTaskId" @click="handleReloadTask">重新加载</Button>
            <Button
              type="primary"
              :loading="saving"
              :disabled="!currentTask"
              @click="handleSave"
            >
              保存映射
            </Button>
          </Space>
        </FormItem>
      </Form>
      <Alert
        v-if="currentTask && currentTask.lastStatus === 'running'"
        class="mt-2"
        type="warning"
        show-icon
        message="该任务正在运行中，后端会拒绝编辑请求（code 40003），请先停止任务再调整字段映射。"
      />
    </Card>

    <Card :bordered="false" class="mb-3" title="任务信息">
      <Descriptions :column="3" size="small">
        <DescriptionsItem label="任务名称">{{ currentTask?.name || '-' }}</DescriptionsItem>
        <DescriptionsItem label="任务 ID">{{ currentTask?.id || '-' }}</DescriptionsItem>
        <DescriptionsItem label="同步模式">
          {{ getSyncModeLabel(currentTask?.syncMode) }}
        </DescriptionsItem>
        <DescriptionsItem label="源表">{{ currentTask?.sourceTable || '-' }}</DescriptionsItem>
        <DescriptionsItem label="目标表">{{ currentTask?.targetTable || '-' }}</DescriptionsItem>
        <DescriptionsItem label="增量列">{{ currentTask?.incrementalColumn || '-' }}</DescriptionsItem>
        <DescriptionsItem label="写入策略">
          {{ currentTask?.writeMode || '-' }}
        </DescriptionsItem>
        <DescriptionsItem label="批次大小">
          {{ formatNumber(currentTask?.batchSize) }}
        </DescriptionsItem>
        <DescriptionsItem label="最近状态">
          <Tag :color="getTaskStatusColor(currentTask?.lastStatus)">
            {{ getTaskStatusLabel(currentTask?.lastStatus) }}
          </Tag>
        </DescriptionsItem>
      </Descriptions>
    </Card>

    <Card :bordered="false" title="字段映射" :loading="detailLoading">
      <template v-if="currentTask">
        <FieldMappingEditor
          :key="editorKey"
          :mappings="mappings"
          @change="handleMappingChange"
        />
      </template>
      <Empty v-else description="请先在上方选择一个同步任务" />
    </Card>
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, ref } from 'vue'
  import { useRoute } from 'vue-router'
  import { Alert, Button, Card, Descriptions, Empty, Form, Select, Space, Tag } from 'ant-design-vue'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllTasksApi, getTaskApi, updateTaskApi } from '/@/api/databridge/task'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { FieldMapping, Task } from '/@/api/databridge/model/taskModel'
  import FieldMappingEditor from '../components/FieldMappingEditor.vue'
  import {
    formatNumber,
    getSyncModeLabel,
    getTaskStatusColor,
    getTaskStatusLabel,
    pickTaskPayload,
    validateFieldTransforms,
  } from '../data'

  const FormItem = Form.Item
  const DescriptionsItem = Descriptions.Item

  const route = useRoute()
  const { createMessage } = useMessage()

  const taskLoading = ref(false)
  const detailLoading = ref(false)
  const saving = ref(false)
  const taskOptions = ref<{ label: string; value: string }[]>([])
  const currentTaskId = ref<string>('')
  const currentTask = ref<Task | null>(null)
  const mappings = ref<FieldMapping[]>([])
  const editorKey = ref(0)

  function handleMappingChange(value: FieldMapping[]) {
    mappings.value = value
  }

  async function loadTasks() {
    taskLoading.value = true
    try {
      const list = await getAllTasksApi()
      taskOptions.value = list.map((item) => ({
        label: `${item.name}（${item.id}）`,
        value: item.id as string,
      }))
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '任务列表加载失败'))
    } finally {
      taskLoading.value = false
    }
  }

  async function loadTaskDetail(taskId: string) {
    if (!taskId) {
      currentTask.value = null
      mappings.value = []
      return
    }
    detailLoading.value = true
    try {
      const detail = await getTaskApi(taskId)
      currentTask.value = detail
      mappings.value = (detail?.fieldMappings ?? []).map((item) => ({ ...item }))
      editorKey.value += 1
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '任务详情加载失败'))
    } finally {
      detailLoading.value = false
    }
  }

  function handleTaskChange(value: string) {
    currentTaskId.value = value
    loadTaskDetail(value)
  }

  function handleReloadTask() {
    loadTaskDetail(currentTaskId.value)
  }

  function validateMappings(list: FieldMapping[]) {
    if (!list.length) {
      createMessage.error('字段映射不能为空')
      return false
    }
    const invalid = list.find((item) => !item.sourceField || !item.targetField)
    if (invalid) {
      createMessage.error('存在未填写源字段或目标字段的映射行')
      return false
    }
    // 转换类型为 constant / expression 时后端要求 value 非空
    const transformError = validateFieldTransforms(list)
    if (transformError) {
      createMessage.error(transformError)
      return false
    }
    return true
  }

  async function handleSave() {
    const task = currentTask.value
    if (!task?.id) {
      createMessage.error('请先选择任务')
      return
    }
    if (!validateMappings(mappings.value)) return
    // 只回传契约 1.2 的请求字段（含每行的 transform），id 走 URL
    const payload = pickTaskPayload({ ...task, fieldMappings: mappings.value })

    saving.value = true
    try {
      await updateTaskApi(task.id, payload)
      createMessage.success(`任务【${task.name}】字段映射已保存`)
      await loadTaskDetail(task.id)
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      saving.value = false
    }
  }

  onMounted(async () => {
    await loadTasks()
    const taskId = route.query.taskId as string | undefined
    if (taskId && taskOptions.value.some((item) => item.value === taskId)) {
      currentTaskId.value = taskId
      loadTaskDetail(taskId)
    }
  })
</script>
