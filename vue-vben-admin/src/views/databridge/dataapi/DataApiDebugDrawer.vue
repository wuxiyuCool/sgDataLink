<template>
  <Drawer
    :visible="visible"
    :width="720"
    title="调试 Data API"
    placement="right"
    @close="handleClose"
  >
    <Descriptions :column="2" size="small" class="mb-3">
      <DescriptionsItem label="服务">{{ api?.name || '-' }}</DescriptionsItem>
      <DescriptionsItem label="状态">
        <Tag :color="getDataApiStatusColor(api?.status)">
          {{ getDataApiStatusLabel(api?.status) }}
        </Tag>
      </DescriptionsItem>
      <DescriptionsItem label="运行时地址" :span="2">
        <span class="mono">{{ runtimeUrl }}</span>
      </DescriptionsItem>
      <DescriptionsItem label="鉴权">
        {{ api?.authEnabled === false ? '关闭' : '开启（需 X-API-Key）' }}
      </DescriptionsItem>
      <DescriptionsItem label="限流">{{ api?.rateLimitQps ?? '-' }} QPS</DescriptionsItem>
    </Descriptions>

    <Card :bordered="false" size="small" class="mb-3">
      <Form layout="inline">
        <FormItem label="page">
          <InputNumber v-model:value="page" :min="1" :max="100000" :precision="0" style="width: 100px" />
        </FormItem>
        <FormItem label="size">
          <InputNumber v-model:value="size" :min="1" :max="500" :precision="0" style="width: 100px" />
        </FormItem>
        <FormItem label="服务地址">
          <Input v-model:value="baseUrl" style="width: 220px" placeholder="http://127.0.0.1:3001" />
        </FormItem>
      </Form>
      <Form v-if="queryParams.length" layout="inline" class="mt-2">
        <FormItem v-for="param in queryParams" :key="param.name" :label="param.name">
          <Input
            v-model:value="paramValues[param.name]"
            :placeholder="`${param.type}${param.required ? '（必填）' : ''}`"
            style="width: 160px"
          />
        </FormItem>
      </Form>
      <div v-else class="text-gray-500">该服务未定义查询参数，可直接调用</div>

      <div class="mt-3">
        <Space>
          <Button type="primary" :loading="invoking" @click="handleInvoke">发起调用</Button>
          <Button @click="handleReset">清空结果</Button>
          <span class="text-gray-500">调试经 POST /data-apis/:id/invoke 代理，计入调用统计</span>
        </Space>
      </div>
    </Card>

    <Alert
      v-if="errorText"
        class="mb-3"
      type="error"
      show-icon
      :message="`调用失败：${errorText}`"
      :description="errorCode ? `业务码 ${errorCode}（契约 1.9：40101 缺少 Key / 40102 无效 Key / 40301 IP 不在白名单 / 42901 超限流 / 40404 未发布）` : ''"
    />

    <Card :bordered="false" size="small" class="mb-3">
      <template #title>
        <Space>
          <span>响应</span>
          <Tag v-if="normalized" :color="normalized.httpStatus < 400 ? 'success' : 'error'">
            HTTP {{ normalized.httpStatus }}
          </Tag>
          <Tag v-if="normalized?.code">业务码 {{ normalized.code }}</Tag>
          <Tag v-if="normalized">共 {{ formatNumber(normalized.data.total) }} 行</Tag>
          <Tag v-if="costMs !== null">耗时 {{ costMs }} ms</Tag>
        </Space>
      </template>
      <Empty v-if="!response" description="尚未调用" />
      <Tabs v-else>
        <TabPane key="table" tab="表格视图">
          <Table
            :columns="resultColumns"
            :data-source="resultRows"
            :pagination="false"
            :scroll="{ x: 600, y: 260 }"
            row-key="__rowKey"
            size="small"
            bordered
          />
        </TabPane>
        <TabPane key="json" tab="格式化 JSON">
          <pre class="json-pre">{{ prettyJson }}</pre>
        </TabPane>
      </Tabs>
    </Card>

    <Card :bordered="false" size="small" title="curl 命令（可复制到终端验证 X-API-Key 与限流）">
      <TextArea :value="curlCommand" :rows="5" readonly class="json-text" />
      <div class="mt-2">
        <Space>
          <Button size="small" @click="handleCopyCurl">复制 curl</Button>
          <span class="text-gray-500">
            API Key 为占位符时请替换为发布时返回的完整 key（后端只在发布响应中给出一次）
          </span>
        </Space>
      </div>
    </Card>
  </Drawer>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref, watch } from 'vue'
  import {
    Alert,
    Button,
    Card,
    Descriptions,
    Drawer,
    Empty,
    Form,
    Input,
    InputNumber,
    Space,
    Table,
    Tabs,
    Tag,
  } from 'ant-design-vue'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { copyTextToClipboard } from '/@/hooks/web/useCopyToClipboard'
  import { invokeDataApiApi } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    DataApi,
    DataApiInvokeResult,
    DataApiQueryParam,
  } from '/@/api/databridge/model/dataapiModel'
  import { formatNumber, getDataApiStatusLabel, getDataApiStatusColor } from '../data'
  import {
    buildCurlCommand,
    DATA_RUNTIME_BASE,
    getRuntimeUrl,
    normalizeInvokeResult,
    toInvokeTableData,
  } from './dataapi.data'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const DescriptionsItem = Descriptions.Item
  const TabPane = Tabs.TabPane

  const props = defineProps({
    visible: { type: Boolean, default: false },
    api: { type: Object as () => DataApi | null, default: null },
  })

  const emit = defineEmits(['update:visible', 'invoked'])

  const { createMessage } = useMessage()

  const page = ref(1)
  const size = ref(20)
  const baseUrl = ref(DATA_RUNTIME_BASE)
  const paramValues = reactive<Recordable>({})
  const invoking = ref(false)
  const response = ref<DataApiInvokeResult | null>(null)
  const errorText = ref('')
  const errorCode = ref<number | undefined>(undefined)
  const costMs = ref<number | null>(null)

  const queryParams = computed<DataApiQueryParam[]>(() => props.api?.queryParams ?? [])
  const runtimeUrl = computed(() => getRuntimeUrl(props.api?.path ?? '', unref(baseUrl)))

  const normalized = computed(() =>
    response.value ? normalizeInvokeResult(response.value) : null,
  )

  const resultColumns = computed(() =>
    (normalized.value?.data.fields ?? []).map((field) => ({
      title: field,
      dataIndex: field,
      key: field,
      width: 140,
      ellipsis: true,
    })),
  )

  const resultRows = computed(() =>
    toInvokeTableData(normalized.value?.data.fields, normalized.value?.data.rows),
  )

  const prettyJson = computed(() => JSON.stringify(normalized.value?.data ?? {}, null, 2))

  const curlCommand = computed(() =>
    buildCurlCommand({
      baseUrl: unref(baseUrl),
      path: props.api?.path ?? '',
      method: props.api?.method,
      page: Number(unref(page) || 1),
      size: Number(unref(size) || 20),
      queryParams: collectParams(),
      apiKey: props.api?.apiKey ?? '',
      authEnabled: props.api?.authEnabled !== false,
    }),
  )

  function collectParams(): Recordable {
    const values: Recordable = {}
    queryParams.value.forEach((param) => {
      const value = paramValues[param.name]
      if (value !== undefined && value !== null && String(value) !== '') values[param.name] = value
    })
    return values
  }

  watch(
    () => [props.visible, props.api?.id],
    () => {
      if (!props.visible) return
      page.value = 1
      size.value = 20
      response.value = null
      errorText.value = ''
      errorCode.value = undefined
      costMs.value = null
      Object.keys(paramValues).forEach((key) => delete paramValues[key])
      queryParams.value.forEach((param) => {
        paramValues[param.name] = ''
      })
    },
  )

  async function handleInvoke() {
    if (!props.api?.id) {
      createMessage.warning('缺少数据服务 id，无法调试')
      return
    }
    invoking.value = true
    errorText.value = ''
    errorCode.value = undefined
    response.value = null
    const startAt = Date.now()
    try {
      const result = await invokeDataApiApi(props.api.id, {
        page: Number(page.value || 1),
        size: Number(size.value || 20),
        queryParams: collectParams(),
      })
      costMs.value = Date.now() - startAt
      response.value = result ?? null
      // 管理端代理本身固定返回 HTTP 200，运行时的 401/403/429/404 在透传的 httpStatus 里，
      // 因此这里按归一化后的状态码决定是提示成功还是展示失败信封
      const normalizedResult = normalizeInvokeResult(result)
      if (normalizedResult.httpStatus >= 400) {
        errorText.value = normalizedResult.message || `运行时返回 HTTP ${normalizedResult.httpStatus}`
        errorCode.value = normalizedResult.code
      } else {
        createMessage.success('调用完成')
      }
      emit('invoked')
    } catch (error: any) {
      costMs.value = Date.now() - startAt
      errorText.value = getApiErrorMessage(error, '调用失败')
      const data = error?.response?.data
      errorCode.value = data?.code
      // 运行时返回的 401/403/429/404 信封也带 code/message，一并展示便于核对契约
      if (data && (data.code !== undefined || data.result)) {
        response.value = {
          ...data,
          httpStatus: data.httpStatus ?? error?.response?.status,
        } as DataApiInvokeResult
      }
      emit('invoked')
    } finally {
      invoking.value = false
    }
  }

  function handleReset() {
    response.value = null
    errorText.value = ''
    errorCode.value = undefined
    costMs.value = null
  }

  function handleCopyCurl() {
    const ok = copyTextToClipboard(unref(curlCommand))
    if (ok) createMessage.success('curl 命令已复制')
    else createMessage.error('复制失败，请手动选择文本复制')
  }

  function handleClose() {
    emit('update:visible', false)
  }
</script>
<style lang="less" scoped>
  .mono,
  .json-pre,
  .json-text {
    font-family: monospace;
  }

  .json-pre {
    max-height: 300px;
    margin: 0;
    padding: 8px;
    overflow: auto;
    background: #fafafa;
    border: 1px solid #f0f0f0;
    border-radius: 4px;
    font-size: 12px;
  }
</style>
