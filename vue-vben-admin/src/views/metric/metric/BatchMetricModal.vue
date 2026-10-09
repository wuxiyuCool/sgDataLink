<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    title="从表生成指标（批量）"
    :width="960"
    :min-height="420"
    :mask-closable="false"
    :confirm-loading="submitting"
    :ok-text="step === 3 ? '重新提交失败项' : '生成指标'"
    :ok-button-props="{ disabled: !canSubmit }"
    @ok="handleSubmit"
  >
    <Steps :current="step - 1" size="small" class="mb-4" :items="STEP_ITEMS" />

    <!-- ① 选来源 -->
    <template v-if="step === 1">
      <Alert
        class="mb-3"
        type="info"
        show-icon
        message="只认「已启用」的模型：草稿模型不能建指标（后端会拒绝）。没登记过的表可以在这里就地登记成引用表模型。"
      />
      <Form layout="vertical">
        <FormItem label="来源方式">
          <Radio.Group v-model:value="sourceMode">
            <Radio value="model">选已登记模型</Radio>
            <Radio value="register">就地登记一张表</Radio>
          </Radio.Group>
        </FormItem>
        <Row :gutter="16">
          <Col :span="12">
            <FormItem label="模型">
              <Select
                v-model:value="form.modelId"
                :options="modelOptions"
                placeholder="已启用的模型（草稿不在列表里）"
                show-search
                option-filter-prop="label"
                style="width: 100%"
                :disabled="sourceMode !== 'model'"
                @change="loadColumns"
              />
            </FormItem>
          </Col>
          <Col :span="12">
            <FormItem label="指标域">
              <TreeSelect
                v-model:value="form.domainId"
                :tree-data="domainOptions"
                tree-default-expand-all
                :disabled="sourceMode !== 'register'"
                placeholder="决定指标归属（选模型时自动带出）"
                style="width: 100%"
              />
            </FormItem>
          </Col>
          <Col v-if="sourceMode === 'register'" :span="12">
            <FormItem label="数据源">
              <Select
                v-model:value="form.datasourceId"
                :options="dsOptions"
                :disabled="sourceMode !== 'register'"
                placeholder="选择数据源"
                show-search
                :filter-option="filterOption"
                style="width: 100%"
                @change="onDatasourceChange"
              />
            </FormItem>
          </Col>
          <Col v-if="sourceMode === 'register'" :span="12">
            <FormItem label="物理表">
              <TableSelect
                v-model:value="form.tableName"
                :datasource-id="form.datasourceId"
                placeholder="先选数据源再选表"
              />
            </FormItem>
          </Col>
        </Row>
        <Button
          v-if="sourceMode === 'register'"
          :loading="registering"
          @click="handleRegisterModel"
        >
          <Icon icon="ant-design:link-outlined" class="mr-1" />
          登记为模型并载入字段
        </Button>
        <div v-if="modelHint" class="model-hint mt-2">{{ modelHint }}</div>
      </Form>
    </template>

    <!-- ② 勾度量列、逐条改名 -->
    <template v-if="step === 2">
      <Alert
        class="mb-3"
        type="info"
        show-icon
        message="勾一行=建一个原子指标；code 预填「模型名_列名」，可逐条改。撞码/非法聚合由后端逐条拒绝并回显原因（不静默改名、不整批回滚）。"
      />
      <Table
        :columns="rowColumns"
        :data-source="rows"
        :pagination="false"
        row-key="_key"
        size="small"
        :scroll="{ x: 820, y: 320 }"
        :row-selection="{
          selectedRowKeys: selectedKeys,
          onChange: (keys: any) => (selectedKeys = keys),
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <Input v-model:value="record.name" size="small" placeholder="指标名" />
          </template>
          <template v-else-if="column.key === 'code'">
            <Input v-model:value="record.code" size="small" placeholder="小写字母开头 3-64 位" />
          </template>
          <template v-else-if="column.key === 'agg'">
            <Select
              v-model:value="record.agg"
              :options="AGG_OPTIONS"
              size="small"
              style="width: 150px"
            />
          </template>
          <template v-else-if="column.key === 'unit'">
            <Input
              v-model:value="record.unit"
              size="small"
              placeholder="元/单/%"
              style="width: 80px"
            />
          </template>
          <template v-else-if="column.key === 'filterSql'">
            <Input
              v-model:value="record.filterSql"
              size="small"
              placeholder="如 t.status = 'PAID'"
            />
          </template>
        </template>
      </Table>
      <div class="mt-2 text-xs opacity-70">
        模型「{{ form.modelName }}」的时间窗口列：{{
          form.timeColumn || '未登记（取数会退化为全量）'
        }}
      </div>
    </template>

    <!-- ③ 逐条结果 -->
    <template v-if="step === 3">
      <Alert
        class="mb-3"
        :type="batchResult.failed ? 'warning' : 'success'"
        show-icon
        :message="`成功 ${batchResult.created} 条，失败 ${batchResult.failed} 条；批量无事务，成功项不回滚`"
      />
      <Table
        :columns="resultColumns"
        :data-source="batchResult.results"
        :pagination="false"
        row-key="index"
        size="small"
        :scroll="{ y: 320 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ok'">
            <Tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? '已创建' : '失败' }}</Tag>
          </template>
        </template>
      </Table>
      <div class="mt-2 text-xs opacity-70">
        改回第 ② 步修正红色项，再点「重新提交失败项」只补失败的那几条（成功项已落库，重投会撞码）。
      </div>
    </template>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref } from 'vue'

  import {
    Alert,
    Button,
    Col,
    Form,
    Input,
    Radio,
    Row,
    Select,
    Steps,
    Table,
    Tag,
    TreeSelect,
  } from 'ant-design-vue'

  import { getDatasourceListApi } from '/@/api/databridge/datasource'
  import {
    createMetricModelApi,
    createMetricsBatchApi,
    getMetricModelApi,
    getMetricModelsApi,
    type MetricBatchItem,
    type MetricBatchResult,
    type MetricModel,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import TableSelect from '../../databridge/components/TableSelect.vue'
  import { AGG_OPTIONS } from '../data'

  const FormItem = Form.Item

  const STEP_ITEMS = [{ title: '选表/模型' }, { title: '勾度量列' }, { title: '逐条结果' }]

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const step = ref(1)
  const sourceMode = ref<'model' | 'register'>('model')
  const modelOptions = ref<{ label: string; value: string }[]>([])
  const domainOptions = ref<any[]>([])
  const dsOptions = ref<{ label: string; value: string }[]>([])
  const registering = ref(false)
  const submitting = ref(false)
  const modelHint = ref('')

  const form = reactive({
    modelId: undefined as string | undefined,
    domainId: undefined as string | undefined,
    datasourceId: undefined as string | undefined,
    tableName: undefined as string | undefined,
    timeColumn: '',
    modelName: '',
  })

  interface DraftRow {
    _key: string
    measureColumn: string
    name: string
    code: string
    agg: string
    unit: string
    filterSql: string
  }

  const rows = ref<DraftRow[]>([])
  const selectedKeys = ref<string[]>([])
  const batchResult = ref<MetricBatchResult>({ results: [], created: 0, failed: 0 })
  /** 上一次提交用的条目（按 results.index 对齐）——「重试失败项」不能拿界面当前行去猜 */
  const lastItems = ref<MetricBatchItem[]>([])

  const rowColumns = [
    { title: '物理列', dataIndex: 'measureColumn', key: 'measureColumn', width: 130 },
    { title: '指标名', key: 'name', width: 150 },
    { title: '编码 code', key: 'code', width: 200 },
    { title: '聚合', key: 'agg', width: 150 },
    { title: '单位', key: 'unit', width: 90 },
    { title: '过滤条件（可选）', key: 'filterSql', width: 190 },
  ]

  const resultColumns = [
    { title: '#', dataIndex: 'index', key: 'index', width: 50 },
    { title: '编码', dataIndex: 'code', key: 'code', width: 200 },
    { title: '结果', key: 'ok', width: 90 },
    { title: '说明', dataIndex: 'message', key: 'message', ellipsis: true },
  ]

  const canSubmit = computed(() => {
    if (step.value === 1) return false
    if (step.value === 2) return selectedKeys.value.length > 0
    return batchResult.value.failed > 0
  })

  /** code 预填：小写字母开头 + 下划线；冲突交给后端逐条报错，界面不静默改名 */
  function suggestCode(columnName: string) {
    const base = `${form.modelName || 'm'}_${columnName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    const safe = /^[a-z]/.test(base) ? base : `m_${base}`
    return safe.slice(0, 60).replace(/_+$/g, '')
  }

  function filterOption(input: string, option: any) {
    return String(option?.label || '')
      .toLowerCase()
      .includes(input.toLowerCase())
  }

  async function loadOnlineModels() {
    try {
      // 一期闸门：草稿/停用模型不能被指标引用，下拉里干脆不给（后端同样会拒）
      const page = await getMetricModelsApi({ page: 1, size: 200, status: 'online' })
      modelOptions.value = (page?.items || []).map((m: MetricModel) => ({
        label: `${m.name}（${m.layer} · ${m.tableName}）`,
        value: m.id,
      }))
    } catch {
      modelOptions.value = []
    }
  }

  async function loadDatasources() {
    try {
      const page = await getDatasourceListApi({ page: 1, size: 200 })
      dsOptions.value = (page?.items || []).map((ds: any) => ({
        label: `${ds.name}（${ds.type}）`,
        value: ds.id,
      }))
    } catch {
      dsOptions.value = []
    }
  }

  function onDatasourceChange() {
    form.tableName = undefined
  }

  async function applyModel(modelId: string) {
    try {
      const detail = await getMetricModelApi(modelId)
      form.modelId = modelId
      form.domainId = detail.domainId
      form.timeColumn = detail.timeColumn || ''
      form.modelName = detail.name
      const measures = (detail.columns || []).filter((c) => c.role === 'measure')
      rows.value = measures.map((c) => ({
        _key: c.columnName,
        measureColumn: c.columnName,
        name: c.bizName || c.columnName,
        code: suggestCode(c.columnName),
        agg:
          c.aggDefault ||
          (/INT|DECIMAL|FLOAT|DOUBLE|NUMERIC/i.test(c.dataType || '') ? 'sum' : 'count'),
        unit: '',
        filterSql: '',
      }))
      selectedKeys.value = rows.value.map((r) => r._key)
      if (!rows.value.length) {
        modelHint.value = `模型「${detail.name}」没有度量列（角色=度量的字段）。去建模页把列角色改成度量，或换一张表。`
        return false
      }
      modelHint.value = `已载入 ${rows.value.length} 个度量列，下一步逐条改名与聚合。`
      return true
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '模型字段加载失败'))
      return false
    }
  }

  async function loadColumns() {
    modelHint.value = ''
    if (!form.modelId) return
    if (await applyModel(form.modelId)) step.value = 2
  }

  async function handleRegisterModel() {
    if (!form.domainId || !form.datasourceId || !form.tableName) {
      createMessage.warning('请先选完 域 + 数据源 + 物理表')
      return
    }
    registering.value = true
    try {
      const created = await createMetricModelApi({
        name: form.tableName,
        datasourceId: form.datasourceId,
        domainId: form.domainId,
        layer: 'DWD',
        tableName: form.tableName,
        createType: 'reference',
        remark: '指标广场「从表生成指标」就地登记',
      })
      await loadOnlineModels()
      if (await applyModel(created.id)) step.value = 2
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '登记模型失败（同表重复登记报 40904）'))
    } finally {
      registering.value = false
    }
  }

  function buildItems(picked: DraftRow[]): MetricBatchItem[] {
    return picked.map((row) => ({
      code: row.code.trim(),
      name: row.name.trim(),
      domainId: form.domainId as string,
      modelId: form.modelId as string,
      measureColumn: row.measureColumn,
      agg: row.agg,
      timeColumn: form.timeColumn || undefined,
      filterSql: row.filterSql.trim() || undefined,
      unit: row.unit.trim() || undefined,
      status: 'online',
    }))
  }

  async function submitItems(items: MetricBatchItem[]) {
    submitting.value = true
    lastItems.value = items
    try {
      batchResult.value = await createMetricsBatchApi(items)
      step.value = 3
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '批量创建失败'))
    } finally {
      submitting.value = false
    }
  }

  async function handleSubmit() {
    if (step.value === 2) {
      const picked = rows.value.filter((r) => selectedKeys.value.includes(r._key))
      if (!picked.length) {
        createMessage.warning('至少勾选一个度量列')
        return
      }
      await submitItems(buildItems(picked))
      return
    }
    if (step.value === 3) {
      const retry = batchResult.value.results
        .filter((r) => !r.ok)
        .map((r) => lastItems.value[r.index])
        .filter(Boolean)
      if (!retry.length) return
      await submitItems(retry)
    }
  }

  const [registerModal] = useModalInner(async (data) => {
    step.value = 1
    sourceMode.value = 'model'
    rows.value = []
    selectedKeys.value = []
    batchResult.value = { results: [], created: 0, failed: 0 }
    lastItems.value = []
    modelHint.value = ''
    form.modelId = undefined
    form.tableName = undefined
    form.datasourceId = undefined
    form.timeColumn = ''
    form.modelName = ''
    domainOptions.value = data?.domainOptions || []
    await Promise.all([loadOnlineModels(), loadDatasources()])
  })
</script>

<style lang="less" scoped>
  .model-hint {
    color: #8c8c8c;
    font-size: 12px;
  }
</style>
