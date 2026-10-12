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
    <Steps :current="step - 1" size="small" class="mb-4">
      <Step v-for="item in STEP_ITEMS" :key="item.title" :title="item.title" />
    </Steps>

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
      <div class="code-bar">
        <Alert
          v-if="codeConflictRows.length"
          class="code-bar-alert"
          type="error"
          show-icon
          :message="`${codeConflictRows.length} 行编码冲突`"
          :description="codeConflictSummary"
        />
        <div v-else class="code-bar-note code-bar-flex">
          {{
            codeChecking
              ? '正在按保存期同一口径校验编码…'
              : '勾选行的编码都可用（与保存期同一份判定）；编码终身制，已删除指标同样占码、不可复用。'
          }}
        </div>
        <div class="code-bar-actions">
          <Button
            size="small"
            :disabled="!suffixTargets.length"
            :loading="codeChecking"
            @click="handleAddSuffix"
          >
            <Icon icon="ant-design:tag-outlined" class="mr-1" />
            一键补后缀
          </Button>
          <span class="code-bar-note">补完请自查名称是否需要跟着改</span>
        </div>
      </div>
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
            <Input
              v-model:value="record.code"
              size="small"
              placeholder="小写字母开头 3-64 位"
              :class="{ 'code-input-error': isRowError(record) }"
            />
            <div
              v-if="rowCodeHint(record)"
              class="code-issue"
              :class="{ 'code-issue-muted': !isRowError(record) }"
            >
              {{ rowCodeHint(record) }}
            </div>
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
      <div class="mt-2 step3-actions">
        <Button size="small" @click="backToEditCodes">
          <Icon icon="ant-design:rollback-outlined" class="mr-1" />
          返回修改编码
        </Button>
        <span class="code-bar-note">
          回到第②步只跳步骤：已填内容与勾选都保留、失败行继续标红；改完点「重新提交失败项」只补失败的那几条。
        </span>
      </div>
    </template>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref, watch } from 'vue'

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
  import { useMetricCodeCheck } from './useMetricCodeCheck'

  const FormItem = Form.Item
  // ant-design-vue 3.2 的 Steps 没有 items 属性（4.x 才有），只能挂 Step 子节点
  const Step = Steps.Step

  const STEP_ITEMS = [{ title: '选表/模型' }, { title: '勾度量列' }, { title: '逐条结果' }]

  const emit = defineEmits(['success', 'register'])
  const { createMessage, createConfirm } = useMessage()

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

  const {
    codeChecking,
    codeConflictRows,
    codeConflictSummary,
    suffixTargets,
    isRowError,
    rowCodeHint,
    refreshAllCodes,
    resetCodeChecks,
    handleAddSuffix,
    scheduleCodeCheck,
    recordSubmitOutcome,
  } = useMetricCodeCheck(() => pickedRows.value)

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

  /** code 预填：小写字母开头 + 下划线；占用与否问后端（口径与保存期同源），界面不静默改名 */
  function suggestCode(columnName: string) {
    const base = `${form.modelName || 'm'}_${columnName}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    const safe = /^[a-z]/.test(base) ? base : `m_${base}`
    return safe.slice(0, 60).replace(/_+$/g, '')
  }

  /** 参与编码校验与冲突计数的行＝勾选的行：没勾的不会提交，报它冲突只会误导 */
  const pickedRows = computed(() =>
    rows.value.filter((row) => selectedKeys.value.includes(row._key)),
  )

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
      // 进第②步先全量问一次占用（含重复次数；旧的成败留痕与新模型无关，一并清掉）
      resetCodeChecks()
      void refreshAllCodes()
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
      // 成败留痕给第②步用：已落库的行不再算冲突，被拒的行继续红并带上后端原话
      recordSubmitOutcome(batchResult.value.results || [])
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
      const picked = pickedRows.value
      if (!picked.length) {
        createMessage.warning('至少勾选一个度量列')
        return
      }
      const conflicts = codeConflictRows.value.length
      if (conflicts) {
        // 不拦死：后端才是权威，前端只提示「这几条会被逐条拒」，让用户自己决定要不要先补后缀
        createConfirm({
          iconType: 'warning',
          title: `仍有 ${conflicts} 行编码冲突`,
          content:
            '提交会被后端逐条拒绝（只有冲突行失败，其余行照常创建）。可先用「一键补后缀」处理，或确认仍然提交。',
          okText: '仍然提交',
          cancelText: '回去改编码',
          onOk: () => submitItems(buildItems(picked)),
        })
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

  /** 第③步「返回修改编码」：只跳步骤，已填内容与勾选都留着，按后端最新状态整批重查一次 */
  async function backToEditCodes() {
    step.value = 2
    await refreshAllCodes()
  }

  // 编码列逐条可改：任一行的编码或勾选状态变了就防抖重查（只查没问过的那几个）
  watch(
    () => rows.value.map((row) => String(row.code || '').trim()).join('\n'),
    () => {
      if (step.value === 2) scheduleCodeCheck()
    },
  )
  watch(selectedKeys, () => {
    if (step.value === 2) scheduleCodeCheck()
  })

  const [registerModal] = useModalInner(async (data) => {
    step.value = 1
    sourceMode.value = 'model'
    rows.value = []
    selectedKeys.value = []
    batchResult.value = { results: [], created: 0, failed: 0 }
    lastItems.value = []
    resetCodeChecks()
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
    color: @text-color-secondary;
    font-size: 12px;
  }

  .code-bar {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .code-bar-alert {
    flex: 1;
    margin-bottom: 0;
  }

  .code-bar-flex {
    flex: 1;
  }

  .code-bar-actions {
    flex-shrink: 0;
  }

  .code-bar-note,
  .code-issue-muted {
    color: @text-color-secondary;
    font-size: 12px;
  }

  .code-issue {
    margin-top: 2px;
    color: @error-color;
    font-size: 12px;
    line-height: 1.4;
  }

  .step3-actions {
    display: flex;
    align-items: center;
  }

  // ant-design-vue 3.2 的 Input 还没有 status 属性（4.x 才加），标红只能自己套主题变量
  .code-input-error {
    border-color: @error-color;

    &:hover,
    &:focus {
      border-color: lighten(@error-color, 10%);
    }

    &:focus {
      box-shadow: 0 0 0 2px fade(@error-color, 20%);
    }

    :deep(.ant-input),
    :deep(.ant-input-affix-wrapper) {
      border-color: @error-color;
    }
  }
</style>
