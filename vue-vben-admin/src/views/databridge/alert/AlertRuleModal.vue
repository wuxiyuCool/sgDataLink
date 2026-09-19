<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑告警规则' : '新建告警规则'"
    :width="760"
    :min-height="360"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Form
      ref="formRef"
      :model="formState"
      :rules="getRules"
      :label-col="{ span: 5 }"
      :wrapper-col="{ span: 18 }"
    >
      <FormItem label="规则名称" name="name">
        <Input v-model:value="formState.name" placeholder="例如：同步失败钉钉告警" />
      </FormItem>
      <FormItem label="生效范围" name="scope">
        <Select v-model:value="formState.scope" :options="ALERT_SCOPE_OPTIONS" />
      </FormItem>
      <FormItem label="触发条件" name="conditions" extra="可多选，命中任一条件即触发告警记录">
        <Select
          v-model:value="formState.conditions"
          mode="multiple"
          :options="ALERT_CONDITION_OPTIONS"
          placeholder="请选择至少一个触发条件"
        />
      </FormItem>
      <FormItem
        v-if="needLagThreshold"
        label="延迟阈值"
        name="thresholdLagMs"
        extra="仅「延迟超阈值」条件使用，单位毫秒（管道 lagMs 超过该值即告警）"
      >
        <InputNumber
          v-model:value="formState.thresholdLagMs"
          :min="0"
          :max="86400000"
          :precision="0"
          addon-after="ms"
          style="width: 100%"
        />
      </FormItem>

      <Divider orientation="left" plain class="!mt-0 !mb-3">通知渠道</Divider>
      <FormItem :wrapper-col="{ span: 24 }">
        <Table
          :columns="channelTableColumns"
          :data-source="formState.channels"
          :pagination="false"
          row-key="__key"
          size="small"
          :bordered="true"
        >
          <template #bodyCell="{ column, index, record }">
            <template v-if="column.key === 'type'">
              <Select
                v-model:value="record.type"
                size="small"
                style="width: 140px"
                :options="ALERT_CHANNEL_OPTIONS"
              />
            </template>
            <template v-else-if="column.key === 'webhook'">
              <Input
                v-model:value="record.webhook"
                size="small"
                :placeholder="getWebhookPlaceholder(record.type)"
              />
            </template>
            <template v-else-if="column.key === 'action'">
              <Button type="link" size="small" danger @click="handleRemoveChannel(index)">
                删除
              </Button>
            </template>
          </template>
        </Table>
        <Button size="small" class="mt-2" @click="handleAddChannel">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新增渠道
        </Button>
        <div class="mt-1 text-gray-500">
          Mock 阶段告警记录会写 channelResult=mock-sent，不发真实 webhook（契约 1.10）
        </div>
      </FormItem>

      <FormItem label="启用" name="enabled">
        <Switch v-model:checked="formState.enabled" />
      </FormItem>
    </Form>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref } from 'vue'
  import {
    Button,
    Divider,
    Form,
    Input,
    InputNumber,
    Select,
    Switch,
    Table,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { createAlertRuleApi, updateAlertRuleApi } from '/@/api/databridge/alert'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { AlertChannelType, AlertRule, AlertRulePayload } from '/@/api/databridge/model/alertModel'
  import {
    ALERT_CHANNEL_OPTIONS,
    ALERT_CONDITION_OPTIONS,
    ALERT_SCOPE_OPTIONS,
    DEFAULT_ALERT_THRESHOLD_LAG_MS,
    pickAlertRulePayload,
  } from '../data'
  import { channelTableColumns } from './alert.data'

  const FormItem = Form.Item

  /** 渠道行编辑用的临时结构（__key 只用于表格 rowKey） */
  type AlertChannelItem = AlertRulePayload['channels'][number]
  interface ChannelRow extends AlertChannelItem {
    __key: string
  }

  const emit = defineEmits(['register', 'success'])
  const { createMessage } = useMessage()

  const formRef = ref()
  const isUpdate = ref(false)
  const submitting = ref(false)
  let rowSeed = 0

  const defaultForm = () => ({
    id: undefined as string | undefined,
    name: '',
    scope: 'all',
    conditions: ['task_failed'] as string[],
    thresholdLagMs: DEFAULT_ALERT_THRESHOLD_LAG_MS as number | null,
    channels: [] as ChannelRow[],
    enabled: true,
  })

  const formState = reactive<ReturnType<typeof defaultForm>>(defaultForm())

  /** 只有勾选了「延迟超阈值」才需要填阈值 */
  const needLagThreshold = computed(() =>
    (formState.conditions ?? []).includes('lag_over_threshold'),
  )

  const getRules = computed<Record<string, any>>(() => ({
    name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }],
    scope: [{ required: true, message: '请选择生效范围', trigger: 'change' }],
    conditions: [
      { required: true, type: 'array', min: 1, message: '请至少选择一个触发条件', trigger: 'change' },
    ],
    thresholdLagMs: needLagThreshold.value
      ? [{ required: true, type: 'number', message: '请填写延迟阈值', trigger: 'change' }]
      : [],
  }))

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    isUpdate.value = !!data?.isUpdate
    submitting.value = false
    Object.assign(formState, defaultForm())
    setModalProps({ confirmLoading: false })
    formRef.value?.clearValidate?.()

    if (data?.record) {
      const record: AlertRule = data.record
      Object.assign(formState, {
        id: record.id,
        name: record.name,
        scope: record.scope || 'all',
        conditions: [...(record.conditions ?? [])],
        thresholdLagMs: record.thresholdLagMs ?? DEFAULT_ALERT_THRESHOLD_LAG_MS,
        channels: (record.channels ?? []).map((item) => ({
          type: item.type,
          webhook: item.webhook,
          __key: nextKey(),
        })),
        enabled: record.enabled !== false,
      })
    }
    if (!formState.channels.length) formState.channels = [createChannelRow()]
  })

  function nextKey() {
    rowSeed += 1
    return `row-${rowSeed}`
  }

  function createChannelRow(): ChannelRow {
    return { type: 'dingtalk' as AlertChannelType, webhook: '', __key: nextKey() }
  }

  function getWebhookPlaceholder(type?: AlertChannelType) {
    if (type === 'email') return '收件邮箱，如 ops@example.com'
    if (type === 'wecom') return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx'
    return 'https://oapi.dingtalk.com/robot/send?access_token=xxx'
  }

  function handleAddChannel() {
    formState.channels = [...formState.channels, createChannelRow()]
  }

  function handleRemoveChannel(index: number) {
    formState.channels = formState.channels.filter((_item, i) => i !== index)
  }

  function validateChannels(): string {
    const channels = formState.channels ?? []
    if (!channels.length) return '请至少配置一个通知渠道'
    if (channels.some((item) => !String(item.webhook).trim())) return '存在未填写 Webhook / 收件人的渠道'
    return ''
  }

  function buildPayload(): AlertRulePayload {
    return pickAlertRulePayload({
      name: formState.name,
      scope: formState.scope,
      conditions: formState.conditions as AlertRulePayload['conditions'],
      thresholdLagMs: needLagThreshold.value
        ? Number(formState.thresholdLagMs ?? DEFAULT_ALERT_THRESHOLD_LAG_MS)
        : null,
      channels: formState.channels.map((item) => ({ type: item.type, webhook: item.webhook })),
      enabled: !!formState.enabled,
    })
  }

  async function handleSubmit() {
    if (formRef.value) {
      try {
        await formRef.value.validate()
      } catch {
        return
      }
    }
    const channelError = validateChannels()
    if (channelError) {
      createMessage.warning(channelError)
      return
    }
    submitting.value = true
    setModalProps({ confirmLoading: true })
    try {
      const payload = buildPayload()
      const id = formState.id
      if (unref(isUpdate) && id) {
        await updateAlertRuleApi(id, payload)
        createMessage.success('告警规则已更新')
      } else {
        await createAlertRuleApi(payload)
        createMessage.success('告警规则已创建')
      }
      closeModal()
      emit('success')
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
      setModalProps({ confirmLoading: false })
    }
  }
</script>
