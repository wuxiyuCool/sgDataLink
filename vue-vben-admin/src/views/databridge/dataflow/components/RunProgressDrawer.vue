<template>
  <Drawer
    :visible="visible"
    :width="520"
    :title="drawerTitle"
    placement="right"
    @close="handleClose"
  >
    <div class="mb-3 flex items-center justify-between">
      <Space>
        <span class="text-gray-500">3s 轮询进度</span>
        <Switch v-model:checked="polling" @change="handlePollingChange" />
      </Space>
      <Button size="small" :loading="loading" @click="loadProgress">
        <Icon icon="ant-design:reload-outlined" class="mr-1" />
        刷新
      </Button>
    </div>

    <Card :bordered="false" size="small" class="mb-3">
      <Progress
        :percent="Number(progress?.progress || 0)"
        :status="getProgressStatus(progress?.status)"
      />
      <div class="mt-1">
        状态：
        <Tag :color="getTaskStatusColor(progress?.status)">
          {{ getTaskStatusLabel(progress?.status) }}
        </Tag>
        <span v-if="progress?.message" class="lag-danger ml-2">{{ progress.message }}</span>
      </div>
    </Card>

    <Descriptions :column="1" size="small" bordered>
      <DescriptionsItem label="运行实例">{{ progress?.instanceId || '-' }}</DescriptionsItem>
      <DescriptionsItem label="总行数">{{ formatNumber(progress?.totalRows) }}</DescriptionsItem>
      <DescriptionsItem label="已读 / 已写">
        {{ formatNumber(progress?.readRows) }} / {{ formatNumber(progress?.writeRows) }}
      </DescriptionsItem>
      <DescriptionsItem label="速率">
        {{ formatNumber(progress?.rateRowsPerSec) }} rows/s
      </DescriptionsItem>
      <DescriptionsItem label="当前位点">
        <span class="offset-text">{{ progress?.currentOffset || '-' }}</span>
      </DescriptionsItem>
      <DescriptionsItem label="开始时间">{{ formatTime(progress?.startedAt) }}</DescriptionsItem>
      <DescriptionsItem label="结束时间">{{ formatTime(progress?.finishedAt) }}</DescriptionsItem>
    </Descriptions>

    <Alert
      class="mt-3"
      type="info"
      show-icon
      message="进度取自 GET /dataflows/:id/progress（结构同任务 progress，taskId 换成 dataflowId）"
    />
  </Drawer>
</template>
<script lang="ts" setup>
  import { computed, onUnmounted, ref, unref, watch } from 'vue'
  import {
    Alert,
    Button,
    Card,
    Descriptions,
    Drawer,
    Progress,
    Space,
    Switch,
    Tag,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getDataflowProgressApi } from '/@/api/databridge/dataflow'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { DataflowProgress } from '/@/api/databridge/model/dataflowModel'
  import {
    POLL_INTERVAL,
    formatNumber,
    formatTime,
    getProgressStatus,
    getTaskStatusColor,
    getTaskStatusLabel,
  } from '../../data'

  const DescriptionsItem = Descriptions.Item

  const props = defineProps({
    visible: { type: Boolean, default: false },
    dataflowId: { type: String, default: '' },
    dataflowName: { type: String, default: '' },
    /** run/stop 之后由父组件递增，用于立刻拉一次 */
    tick: { type: Number, default: 0 },
  })

  const emit = defineEmits(['update:visible'])

  const { createMessage } = useMessage()
  const loading = ref(false)
  const polling = ref(true)
  const progress = ref<DataflowProgress | null>(null)
  let timer: IntervalHandle | null = null

  const drawerTitle = computed(() =>
    props.dataflowName ? `运行进度 · ${props.dataflowName}` : '运行进度',
  )

  async function loadProgress() {
    if (!props.dataflowId) return
    loading.value = true
    try {
      progress.value = await getDataflowProgressApi(props.dataflowId)
      // 运行结束后自动停止轮询，避免无意义请求
      if (progress.value?.status !== 'running') stopTimer()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '进度加载失败'))
      stopTimer()
    } finally {
      loading.value = false
    }
  }

  function startTimer() {
    stopTimer()
    if (!unref(polling)) return
    timer = setInterval(() => {
      loadProgress()
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

  function handleClose() {
    emit('update:visible', false)
  }

  watch(
    () => [props.visible, props.dataflowId, props.tick],
    () => {
      if (!props.visible || !props.dataflowId) {
        stopTimer()
        return
      }
      progress.value = null
      loadProgress().then(() => {
        if (unref(polling)) startTimer()
      })
    },
  )

  onUnmounted(() => {
    stopTimer()
  })
</script>
<style lang="less" scoped>
  .offset-text {
    font-family: monospace;
    word-break: break-all;
  }

  .lag-danger {
    color: #cf1322;
  }
</style>
