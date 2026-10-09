<template>
  <PageWrapper
    title="指标中心 · 系统配置"
    content="LLM 连接参数（OpenAI 兼容协议，DeepSeek/通义/GLM/硅基流动任选，本地可指 Ollama）。保存后进 metric_setting 表，优先级高于服务端环境变量；API Key 只存服务端、界面仅回显掩码。仅管理员可操作。"
  >
    <GuideCard :guide="PAGE_GUIDES.setting" />
    <Card :bordered="false" :loading="loading">
      <Form :model="form" layout="vertical" class="max-w-2xl" @finish="handleSave">
        <FormItem name="baseUrl">
          <template #label>
            <LabelWithSource
              label="Base URL"
              item-key="llm.baseUrl"
              :items="items"
              placeholder="如 https://api.deepseek.com/v1"
            />
          </template>
          <Input
            v-model:value="form.baseUrl"
            placeholder="https://api.deepseek.com/v1"
            allow-clear
          />
        </FormItem>
        <FormItem name="model">
          <template #label>
            <LabelWithSource label="模型" item-key="llm.model" :items="items" />
          </template>
          <Input
            v-model:value="form.model"
            placeholder="deepseek-chat / qwen-plus / glm-4-flash ..."
            allow-clear
          />
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
          <Switch
            v-model:checked="form.embedEnabled"
            checked-children="开"
            un-checked-children="关"
          />
        </FormItem>
        <FormItem v-if="form.embedEnabled" name="embedModel">
          <template #label>
            <LabelWithSource label="Embedding 模型" item-key="llm.embedModel" :items="items" />
          </template>
          <Input
            v-model:value="form.embedModel"
            placeholder="如 BAAI/bge-m3（硅基流动）/ text-embedding-3-small"
            allow-clear
          />
        </FormItem>
        <FormItem v-if="form.embedEnabled" name="embedBaseUrl">
          <template #label>
            <LabelWithSource
              label="Embedding Base URL"
              item-key="llm.embed.baseUrl"
              :items="items"
              placeholder="留空 = 复用上方对话模型 Base URL"
            />
          </template>
          <Input
            v-model:value="form.embedBaseUrl"
            placeholder="如 https://api.siliconflow.cn/v1（与对话模型不同供应商时填写）"
            allow-clear
          />
        </FormItem>
        <FormItem v-if="form.embedEnabled" name="embedApiKey">
          <template #label>
            <LabelWithSource label="Embedding API Key" item-key="llm.embed.apiKey" :items="items" />
          </template>
          <Input.Password
            v-model:value="form.embedApiKey"
            :placeholder="embedApiKeyPlaceholder"
            autocomplete="new-password"
            allow-clear
          />
          <div class="mt-1 text-gray-400" style="font-size: 12px">
            留空 = 保持不变；不单独配置时复用上方对话模型的 API Key。
          </div>
        </FormItem>
        <FormItem label="候选值进问数 Prompt（维度取值/码值，默认关闭）" name="dimValuePrompt">
          <Switch
            v-model:checked="form.dimValuePrompt"
            checked-children="开"
            un-checked-children="关"
          />
          <div class="mt-1 text-gray-400" style="font-size: 12px">
            打开后，建模页探查到的维度取值（如
            <code>01=华东</code
            >）会作为「可用维度」的一部分发给大模型，用来把「只看华东」翻译成库里的真实值。
            <b>取值就是真实业务数据</b>，会随 prompt 出站，请按环境显式确认后再开；关闭时仅停用
            prompt， 已登记码值的「值校正」在服务端本地生效、不外发数据。
          </div>
        </FormItem>
        <FormItem v-if="form.dimValuePrompt" name="dimValueTopN">
          <template #label>
            <LabelWithSource
              label="每列进 Prompt 的取值条数"
              item-key="chat.dimValueTopN"
              :items="items"
              placeholder="默认 20，上限 200"
            />
          </template>
          <Input v-model:value="form.dimValueTopN" placeholder="20" allow-clear />
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
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import {
    getMetricSettingsApi,
    updateMetricSettingsApi,
    type MetricSettingItem,
  } from '/@/api/databridge/metric'

  const FormItem = Form.Item

  /** 带来源徽标的 label（table=已保存 / env=服务端环境变量 / default=默认值） */
  const LabelWithSource = (props: {
    label: string
    itemKey: string
    items: MetricSettingItem[]
  }) => {
    const item = props.items.find((i) => i.settingKey === props.itemKey)
    const sourceText =
      item?.source === 'table' ? '已保存' : item?.source === 'env' ? '环境变量' : '默认'
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
        sourceText,
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
    embedBaseUrl: '',
    embedApiKey: '',
    dimValuePrompt: false,
    dimValueTopN: '',
  })

  const apiKeyPlaceholder = computed(() => {
    const key = items.value.find((i) => i.settingKey === 'llm.apiKey')
    return key?.hasValue && key.value ? `已配置（${key.value}），留空保持不变` : 'sk-...'
  })

  const embedApiKeyPlaceholder = computed(() => {
    const key = items.value.find((i) => i.settingKey === 'llm.embed.apiKey')
    if (key?.hasValue && key.value) return `已单独配置（${key.value}），留空保持不变`
    return '留空 = 复用上方对话模型 API Key'
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
      form.embedBaseUrl = itemValue('llm.embed.baseUrl') || ''
      form.embedEnabled =
        itemValue('llm.embed.enabled') === '1' || itemValue('llm.embed.enabled') === 'true'
      form.dimValuePrompt =
        itemValue('chat.dimValuePrompt') === '1' || itemValue('chat.dimValuePrompt') === 'true'
      form.dimValueTopN = itemValue('chat.dimValueTopN') || ''
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
    if (form.embedBaseUrl.trim()) llm.embed.baseUrl = form.embedBaseUrl.trim()
    if (form.embedApiKey.trim()) llm.embed.apiKey = form.embedApiKey.trim()
    if (form.embedModel.trim()) llm.embedModel = form.embedModel.trim()
    // 契约 1.14：开关是显式布尔（关也要下发），条数留空=不改
    const chat: MetricSettingsPayloadChat = { dimValuePrompt: form.dimValuePrompt ? '1' : '0' }
    if (form.dimValueTopN.trim()) chat.dimValueTopN = form.dimValueTopN.trim()
    saving.value = true
    try {
      const result = await updateMetricSettingsApi({ settings: { llm, chat } })
      createMessage.success(`已保存 ${result.updated.length} 项配置`)
      form.apiKey = ''
      form.embedApiKey = ''
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

  type MetricSettingsPayloadChat = NonNullable<
    Parameters<typeof updateMetricSettingsApi>[0]['settings']['chat']
  >

  onMounted(fetchSettings)
</script>
