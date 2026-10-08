<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? `编辑指标：${recordName}` : '新建指标'"
    :width="820"
    :min-height="360"
    :mask-closable="false"
    :confirm-loading="submitting"
    ok-text="保存"
    @ok="handleSubmit"
  >
    <Form ref="formRef" :model="form" :rules="rules" layout="vertical">
      <Row :gutter="16">
        <Col :span="12">
          <FormItem label="指标名称" name="name">
            <Input v-model:value="form.name" placeholder="如 订单总金额" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="编码（复合公式 ${code} 的引用锚点，创建后不可改）" name="code">
            <Input
              v-model:value="form.code"
              :disabled="isUpdate"
              placeholder="^[a-z][a-z0-9_]{2,63}$"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="别名（问数召回用，回车添加）" name="alias">
            <Select v-model:value="form.alias" mode="tags" :options="[]" placeholder="如 成交额" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="指标域" name="domainId">
            <TreeSelect
              v-model:value="form.domainId"
              :tree-data="domainOptions"
              tree-default-expand-all
              placeholder="选择域"
              style="width: 100%"
            />
          </FormItem>
        </Col>
      </Row>

      <Divider orientation="left">定义方式</Divider>
      <RadioGroup v-model:value="kind" button-style="solid" class="mb-3">
        <RadioButton value="MEASURE">原子·度量聚合</RadioButton>
        <RadioButton value="FIELD">原子·字段表达式</RadioButton>
        <RadioButton value="DERIVED">派生·继承基底</RadioButton>
        <RadioButton value="COMPOSITE">复合·公式</RadioButton>
      </RadioGroup>

      <!-- 原子 MEASURE -->
      <Row v-if="kind === 'MEASURE'" :gutter="16">
        <Col :span="12">
          <FormItem label="模型" required>
            <Select
              v-model:value="form.defineParams.modelId"
              :options="modelOptions"
              show-search
              :filter-option="filterOption"
              placeholder="度量字段所在模型"
              @change="handleModelChange"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="度量列" required>
            <Select
              v-model:value="form.defineParams.measureColumn"
              :options="measureColumnOptions"
              placeholder="role=measure 的列"
            />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="聚合" required>
            <Select v-model:value="form.defineParams.agg" :options="AGG_OPTIONS" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="时间列">
            <Select
              v-model:value="form.defineParams.timeColumn"
              :options="allColumnOptions"
              allow-clear
              placeholder="默认取模型时间列"
            />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="单位">
            <Input v-model:value="form.unit" placeholder="如 元 / 单" />
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem label="业务过滤（编译进聚合 CASE WHEN，写 t.列名 条件）">
            <Input v-model:value="form.defineParams.filterSql" placeholder="如 t.status='PAID'" />
          </FormItem>
        </Col>
      </Row>

      <!-- 原子 FIELD -->
      <Row v-if="kind === 'FIELD'" :gutter="16">
        <Col :span="12">
          <FormItem label="模型" required>
            <Select
              v-model:value="form.defineParams.modelId"
              :options="modelOptions"
              show-search
              :filter-option="filterOption"
              @change="handleModelChange"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="时间列">
            <Select
              v-model:value="form.defineParams.timeColumn"
              :options="allColumnOptions"
              allow-clear
            />
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem label="表达式（必须含聚合函数）" required>
            <Input
              v-model:value="form.defineParams.expr"
              placeholder="如 SUM(CASE WHEN t.status='PAID' THEN t.amt ELSE 0 END)"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="单位">
            <Input v-model:value="form.unit" />
          </FormItem>
        </Col>
      </Row>

      <!-- 派生 -->
      <Row v-if="kind === 'DERIVED'" :gutter="16">
        <Col :span="12">
          <FormItem label="基底指标" required>
            <Select
              v-model:value="form.defineParams.baseMetricId"
              :options="baseMetricOptions"
              show-search
              :filter-option="false"
              placeholder="搜索原子指标名称/编码"
              @search="searchBaseMetrics"
              @change="handleBaseChange"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="维度限定（可多选，问数分组白名单）">
            <Select
              v-model:value="form.defineParams.dimensions"
              :options="baseDimensionOptions"
              mode="multiple"
              allow-clear
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="时间预设">
            <Space>
              <span>近</span>
              <InputNumber
                v-model:value="form.timePresetDays"
                :min="1"
                :max="3650"
                style="width: 100px"
              />
              <span>天</span>
              <Checkbox v-model:checked="form.timePresetOff">不预设</Checkbox>
            </Space>
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem label="业务过滤">
            <Input v-model:value="form.defineParams.filterSql" placeholder="如 t.region='华东'" />
          </FormItem>
        </Col>
      </Row>

      <!-- 复合 -->
      <template v-if="kind === 'COMPOSITE'">
        <Row :gutter="16">
          <Col :span="14">
            <FormItem
              label="公式（${指标编码} + 数字 + + - * / ( ) + CASE WHEN + 白名单函数）"
              required
            >
              <Textarea
                v-model:value="form.expr"
                :rows="3"
                placeholder="如 ${order_amt} / ${order_cnt}"
              />
            </FormItem>
          </Col>
          <Col :span="10">
            <div class="picker-box">
              <Input.Search placeholder="搜索可引用指标" enter-button @search="searchRefMetrics" />
              <div class="picker-list">
                <div
                  v-for="m in refMetrics"
                  :key="m.id"
                  class="picker-item"
                  @click="insertRef(m.code)"
                >
                  {{ m.name }} <span class="picker-code" v-text="`\${${m.code}}`"></span>
                </div>
                <Empty
                  v-if="!refMetrics.length"
                  :image="Empty.PRESENTED_IMAGE_SIMPLE"
                  description="点搜索加载"
                />
              </div>
            </div>
          </Col>
        </Row>
        <div class="mb-2">
          <Button size="small" :loading="validating" @click="handleValidate">公式校验</Button>
          <span
            v-if="validateResult"
            :class="validateResult.valid ? 'text-green' : 'text-red'"
            style="margin-left: 8px"
          >
            {{ validateResult.valid ? '校验通过' : `错误 ${validateResult.errors.length} 项` }}
          </span>
        </div>
        <Alert
          v-if="validateResult && !validateResult.valid"
          type="error"
          :message="validateResult.errors.join('；')"
          class="mb-2"
        />
        <Alert
          v-if="validateResult?.warnings?.length"
          type="warning"
          :message="validateResult.warnings.join('；')"
          class="mb-2"
        />
      </template>

      <Divider orientation="left">治理信息</Divider>
      <Row :gutter="16">
        <Col :span="8">
          <FormItem label="状态">
            <Select v-model:value="form.status" :options="METRIC_STATUS_OPTIONS" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="负责人">
            <Input v-model:value="form.owner" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="数据格式">
            <Select
              v-model:value="form.dataFormat"
              :options="[
                { label: '千分位', value: 'THOUSANDTH' },
                { label: '百分比', value: 'PERCENT' },
                { label: '数值（默认）', value: 'DECIMAL' },
              ]"
              allow-clear
              placeholder="默认数值"
            />
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem label="业务口径">
            <Textarea
              v-model:value="form.caliber"
              :rows="2"
              placeholder="如：成交后实收金额，不含取消"
            />
          </FormItem>
        </Col>
      </Row>
    </Form>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref } from 'vue'

  import {
    Alert,
    Checkbox,
    Divider,
    Empty,
    Form,
    Input,
    InputNumber,
    Radio,
    Row,
    Col,
    Select,
    Space,
    TreeSelect,
  } from 'ant-design-vue'

  import {
    createMetricApi,
    getMetricApi,
    getMetricModelsApi,
    getMetricModelApi,
    getMetricsApi,
    updateMetricApi,
    validateMetricApi,
    type MetricItem,
    type MetricModelColumn,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { AGG_OPTIONS, METRIC_STATUS_OPTIONS } from '../data'

  const FormItem = Form.Item
  const Textarea = Input.TextArea
  const RadioGroup = Radio.Group
  const RadioButton = Radio.Button

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const isUpdate = ref(false)
  const submitting = ref(false)
  const validating = ref(false)
  const recordName = ref('')
  const domainOptions = ref<any[]>([])
  const kind = ref<'MEASURE' | 'FIELD' | 'DERIVED' | 'COMPOSITE'>('MEASURE')

  const modelOptions = ref<{ label: string; value: string }[]>([])
  const modelColumns = ref<MetricModelColumn[]>([])
  const baseMetricOptions = ref<{ label: string; value: string }[]>([])
  const baseDimensionOptions = ref<{ label: string; value: string }[]>([])
  const refMetrics = ref<MetricItem[]>([])
  const validateResult = ref<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)

  const form = reactive({
    id: '',
    code: '',
    name: '',
    alias: [] as string[],
    domainId: undefined as string | undefined,
    unit: '',
    caliber: '',
    owner: '',
    dataFormat: undefined as string | undefined,
    status: 'online',
    expr: '',
    timePresetDays: 30,
    timePresetOff: false,
    defineParams: {
      modelId: undefined as string | undefined,
      measureColumn: undefined as string | undefined,
      agg: 'sum',
      timeColumn: undefined as string | undefined,
      filterSql: '',
      expr: '',
      baseMetricId: undefined as string | undefined,
      dimensions: [] as string[],
    },
  })

  const rules = {
    name: [{ required: true, message: '请输入指标名称' }],
    code: [
      { required: true, message: '请输入指标编码' },
      { pattern: /^[a-z][a-z0-9_]{2,63}$/, message: '编码需匹配 ^[a-z][a-z0-9_]{2,63}$' },
    ],
    domainId: [{ required: true, message: '请选择指标域' }],
  }

  const measureColumnOptions = computed(() =>
    modelColumns.value
      .filter((c) => c.role === 'measure')
      .map((c) => ({
        label: `${c.bizName || c.columnName}（${c.columnName}）`,
        value: c.columnName,
      })),
  )

  const allColumnOptions = computed(() =>
    modelColumns.value.map((c) => ({
      label: `${c.bizName || c.columnName}（${c.columnName}）`,
      value: c.columnName,
    })),
  )

  function filterOption(input: string, option: any) {
    return String(option?.label || '')
      .toLowerCase()
      .includes(input.toLowerCase())
  }

  async function ensureModels() {
    if (modelOptions.value.length) return
    try {
      const page = await getMetricModelsApi({ page: 1, size: 200 })
      modelOptions.value = (page?.items || []).map((m) => ({
        label: `${m.name}（${m.tableName}）`,
        value: m.id,
      }))
    } catch {
      modelOptions.value = []
    }
  }

  async function handleModelChange(modelId: string) {
    form.defineParams.measureColumn = undefined
    form.defineParams.timeColumn = undefined
    modelColumns.value = []
    if (!modelId) return
    try {
      const detail = await getMetricModelApi(modelId)
      modelColumns.value = detail?.columns || []
      form.defineParams.timeColumn = detail?.timeColumn || undefined
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '模型字段加载失败'))
    }
  }

  async function searchBaseMetrics(keyword: string) {
    try {
      const page = await getMetricsApi({
        keyword: keyword || undefined,
        type: 'ATOMIC',
        status: 'online',
        page: 1,
        size: 50,
      })
      baseMetricOptions.value = (page?.items || []).map((m) => ({
        label: `${m.name}（${m.code}）`,
        value: m.id,
      }))
    } catch {
      baseMetricOptions.value = []
    }
  }

  async function handleBaseChange(baseId: string) {
    baseDimensionOptions.value = []
    if (!baseId) return
    try {
      const base = await getMetricApi(baseId)
      const modelId = base?.modelId || base?.defineParams?.modelId
      if (!modelId) return
      const detail = await getMetricModelApi(modelId)
      baseDimensionOptions.value = (detail?.columns || [])
        .filter((c) => c.role === 'dimension')
        .map((c) => ({
          label: `${c.bizName || c.columnName}（${c.columnName}）`,
          value: c.columnName,
        }))
    } catch {
      baseDimensionOptions.value = []
    }
  }

  async function searchRefMetrics(keyword: string) {
    try {
      const page = await getMetricsApi({ keyword: keyword || undefined, page: 1, size: 50 })
      refMetrics.value = page?.items || []
    } catch {
      refMetrics.value = []
    }
  }

  function insertRef(code: string) {
    form.expr = `${form.expr}$${'{'}${code}${'}'}`
  }

  function buildPayload(): Partial<MetricItem> {
    const base = {
      code: form.code.trim(),
      name: form.name.trim(),
      alias: form.alias,
      domainId: form.domainId,
      unit: form.unit,
      caliber: form.caliber,
      owner: form.owner,
      dataFormat: form.dataFormat,
      status: form.status as MetricItem['status'],
    }
    if (kind.value === 'COMPOSITE') {
      return { ...base, defineType: 'METRIC', expr: form.expr }
    }
    if (kind.value === 'DERIVED') {
      return {
        ...base,
        defineType: 'METRIC',
        expr: null as any,
        defineParams: {
          baseMetricId: form.defineParams.baseMetricId,
          dimensions: form.defineParams.dimensions,
          filterSql: form.defineParams.filterSql || undefined,
          timePreset: form.timePresetOff ? null : { mode: 'RECENT', days: form.timePresetDays },
        },
      }
    }
    if (kind.value === 'FIELD') {
      return {
        ...base,
        defineType: 'FIELD',
        expr: null as any,
        defineParams: {
          modelId: form.defineParams.modelId,
          expr: form.defineParams.expr,
          timeColumn: form.defineParams.timeColumn || undefined,
        },
      }
    }
    return {
      ...base,
      defineType: 'MEASURE',
      expr: null as any,
      defineParams: {
        modelId: form.defineParams.modelId,
        measureColumn: form.defineParams.measureColumn,
        agg: form.defineParams.agg,
        timeColumn: form.defineParams.timeColumn || undefined,
        filterSql: form.defineParams.filterSql || undefined,
      },
    }
  }

  async function handleValidate() {
    validating.value = true
    try {
      validateResult.value = await validateMetricApi(buildPayload())
    } catch (error) {
      validateResult.value = null
      createMessage.error(getApiErrorMessage(error, '校验请求失败'))
    } finally {
      validating.value = false
    }
  }

  function fillForm(record: MetricItem) {
    form.id = record.id
    form.code = record.code
    form.name = record.name
    form.alias = record.alias ? [...record.alias] : []
    form.domainId = record.domainId
    form.unit = record.unit || ''
    form.caliber = record.caliber || ''
    form.owner = record.owner || ''
    form.dataFormat = record.dataFormat || undefined
    form.status = record.status
    form.expr = record.expr || ''
    const dp = record.defineParams || {}
    form.defineParams = {
      modelId: dp.modelId,
      measureColumn: dp.measureColumn,
      agg: dp.agg || 'sum',
      timeColumn: dp.timeColumn,
      filterSql: dp.filterSql || '',
      expr: (dp as any).expr || (record.defineType === 'FIELD' ? record.expr || '' : ''),
      baseMetricId: dp.baseMetricId,
      dimensions: dp.dimensions ? [...dp.dimensions] : [],
    }
    form.timePresetDays = dp.timePreset?.days || 30
    form.timePresetOff = !dp.timePreset
    if (record.defineType === 'METRIC') {
      kind.value = dp.baseMetricId ? 'DERIVED' : 'COMPOSITE'
      if (dp.baseMetricId) {
        baseMetricOptions.value = [
          { label: `${record.name} 基底（${dp.baseMetricId}）`, value: dp.baseMetricId },
        ]
        handleBaseChange(dp.baseMetricId)
      }
    } else {
      kind.value = record.defineType
      if (dp.modelId)
        handleModelChange(dp.modelId).then(() => {
          form.defineParams.modelId = dp.modelId
          form.defineParams.measureColumn = dp.measureColumn
          form.defineParams.timeColumn = dp.timeColumn
        })
    }
  }

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    validateResult.value = null
    modelColumns.value = []
    refMetrics.value = []
    domainOptions.value = data?.domainOptions || []
    await ensureModels()
    isUpdate.value = !!data?.isUpdate
    recordName.value = data?.record?.name || ''
    if (data?.record) {
      fillForm(data.record as MetricItem)
    } else {
      form.id = ''
      form.code = ''
      form.name = ''
      form.alias = []
      form.domainId = undefined
      form.unit = ''
      form.caliber = ''
      form.owner = ''
      form.dataFormat = undefined
      form.status = 'online'
      form.expr = ''
      form.defineParams = { agg: 'sum', filterSql: '', dimensions: [] }
      form.timePresetDays = 30
      form.timePresetOff = false
      kind.value = 'MEASURE'
      baseMetricOptions.value = []
      searchBaseMetrics('')
    }
  })

  async function handleSubmit() {
    submitting.value = true
    try {
      const payload = buildPayload()
      if (isUpdate.value && form.id) {
        await updateMetricApi(form.id, payload)
        createMessage.success('指标已更新（版本 +1）')
      } else {
        await createMetricApi(payload)
        createMessage.success('指标已创建')
      }
      closeModal()
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败（校验错误会被后端拦截）'))
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .picker-box {
    border: 1px solid #f0f0f0;
    border-radius: 4px;
    padding: 8px;

    .picker-list {
      max-height: 220px;
      overflow-y: auto;
      margin-top: 8px;
    }

    .picker-item {
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 4px;

      &:hover {
        background: #e6f4ff;
      }

      .picker-code {
        color: #999;
        font-size: 12px;
      }
    }
  }

  .text-green {
    color: #52c41a;
  }

  .text-red {
    color: #ff4d4f;
  }
</style>
