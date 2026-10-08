<template>
  <PageWrapper
    title="指标中心 · 系统配置"
    content="LLM 连接参数（OpenAI 兼容协议，DeepSeek/通义/GLM/硅基流动任选，本地可指 Ollama）。保存后进 metric_setting 表，优先级高于服务端环境变量；API Key 只存服务端、界面仅回显掩码。仅管理员可操作。"
  >
    <Card :bordered="false" :loading="loading">
      <Form :model="form" layout="vertical" class="max-w-2xl" @finish="handleSave">
        <FormItem name="baseUrl">
          <template #label>
            <LabelWithSource label="Base URL" item-key="llm.baseUrl" :items="items" placeholder="如 https://api.deepseek.com/v1" />
          </template>
          <Input v-model:value="form.baseUrl" placeholder="https://api.deepseek.com/v1" allow-clear />
        </FormItem>
        <FormItem name="model">
          <template #label>
            <LabelWithSource label="模型" item-key="llm.model" :items="items" />
          </template>
          <Input v-model:value="form.model" placeholder="deepseek-chat / qwen-plus / glm-4-flash ..." allow-clear />
        </FormItem>
        <FormItem name="apiKey">
          <template #label>
            <LabelWithSource label="API Key" item-key="llm.apiKey" :items="items" />
          </template>
          <Input.Password
            v-model:value="form.apiKey"
            :placeholder="apiKeyPlaceholder"
            autocomplete="new-password"
            allow-clear
          />
          <div class="mt-1 text-gray-400" style="font-size: 12px">
            留空 = 保持不变；要清空请先到服务器 env 处理（界面不提供清除密钥通道）。
          </div>
        </FormItem>
        <FormItem name="timeoutMs">
          <template #label>
            <LabelWithSource label="超时（毫秒）" item-key="llm.timeoutMs" :items="items" />
          </template>
          <Input v-model:value="form.timeoutMs" placeholder="30000" allow-clear />
        </FormItem>
        <FormItem label="向量召回（embedding 增强，默认关闭）" name="embedEnabled">
          <Switch v-model:checked="form.embedEnabled" checked-children="开" un-checked-children="关" />
        </FormItem>
        <FormItem v-if="form.embedEnabled" name="embedModel">
          <template #label>
            <LabelWithSource label="Embedding 模型" item-key="llm.embedModel" :items="items" />
          </template>
          <Input v-model:value="form.embedModel" placeholder="如 BAAI/bge-m3（硅基流动）/ text-embedding-3-small" allow-clear />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" html-type="submit" :loading="saving">保存</Button>
            <Button @click="fetchSettings">重新加载</Button>
          </Space>
        </FormItem>
      </Form>
      <Alert
        type="info"
        show-icon
        message="连通性自检：保存后可在「智能问数」页发一个问题验证（M5 提供）；LLM 不可达只影响问数，不影响指标的建模/编译/清洗任务。"
      />
    </Card>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, h, onMounted, reactive, ref } from 'vue'

  import { Alert, Button, Card, Form, Input, Space, Switch } from 'ant-design-vue'

  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import {
    getMetricSettingsApi,
    updateMetricSettingsApi,
    type MetricSettingItem,
  } from '/@/api/databridge/metric'

  const FormItem = Form.Item

  /** 带来源徽标的 label（table=已保存 / env=服务端环境变量 / default=默认值） */
  const LabelWithSource = (props: { label: string; itemKey: string; items: MetricSettingItem[] }) => {
    const item = props.items.find((i) => i.settingKey === props.itemKey)
    const sourceText = item?.source === 'table' ? '已保存' : item?.source === 'env' ? '环境变量' : '默认'
    const color = item?.source === 'table' ? 'green' : item?.source === 'env' ? 'blue' : 'default'
    return h('span', [
      props.label,
      h(
        'span',
        {
          style: {
            marginLeft: '8px',
            fontSize: '12px',
            color: item?.source === 'default' ? '#999' : color === 'green' ? '#52c41a' : '#1677ff',
          },
        },
        sourceText
      ),
    ])
  }

  const { createMessage } = useMessage()
  const loading = ref(false)
  const saving = ref(false)
  const items = ref<MetricSettingItem[]>([])

  const form = reactive({
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: '',
    embedEnabled: false,
    embedModel: '',
  })

  const apiKeyPlaceholder = computed(() => {
    const key = items.value.find((i) => i.settingKey === 'llm.apiKey')
    return key?.hasValue && key.value ? `已配置（${key.value}），留空保持不变` : 'sk-...'
  })

  function itemValue(key: string): string | null {
    return items.value.find((i) => i.settingKey === key)?.value ?? null
  }

  async function fetchSettings() {
    loading.value = true
    try {
      const result = await getMetricSettingsApi()
      items.value = result.items || []
      // 非敏感项回填生效值；secret 项不回填（掩码无意义），embed.enabled 归一为布尔
      form.baseUrl = itemValue('llm.baseUrl') || ''
      form.model = itemValue('llm.model') || ''
      form.timeoutMs = itemValue('llm.timeoutMs') || ''
      form.embedModel = itemValue('llm.embedModel') || ''
      form.embedEnabled = itemValue('llm.embed.enabled') === '1' || itemValue('llm.embed.enabled') === 'true'
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '读取配置失败'))
    } finally {
      loading.value = false
    }
  }

  async function handleSave() {
    const llm: MetricSettingsPayloadLlm = {}
    if (form.baseUrl.trim()) llm.baseUrl = form.baseUrl.trim()
    if (form.model.trim()) llm.model = form.model.trim()
    if (form.apiKey.trim()) llm.apiKey = form.apiKey.trim()
    if (form.timeoutMs.trim()) llm.timeoutMs = form.timeoutMs.trim()
    llm.embed = { enabled: form.embedEnabled ? '1' : '0' }
    if (form.embedModel.trim()) llm.embedModel = form.embedModel.trim()
    saving.value = true
    try {
      const result = await updateMetricSettingsApi({ settings: { llm } })
      createMessage.success(`已保存 ${result.updated.length} 项配置`)
      form.apiKey = ''
      await fetchSettings()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存配置失败'))
    } finally {
      saving.value = false
    }
  }

  type MetricSettingsPayloadLlm = NonNullable<
    Parameters<typeof updateMetricSettingsApi>[0]['settings']['llm']
  >

  onMounted(fetchSettings)
</script>
