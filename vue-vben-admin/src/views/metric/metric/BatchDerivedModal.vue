<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    title="批量派生指标"
    :width="960"
    :min-height="420"
    :mask-closable="false"
    :confirm-loading="submitting"
    :ok-text="okText"
    :ok-button-props="{ disabled: !canSubmit }"
    @ok="handleSubmit"
  >
    <Steps :current="step - 1" size="small" class="mb-4">
      <Step v-for="item in STEP_ITEMS" :key="item.title" :title="item.title" />
    </Steps>

    <!-- ① 选基底与展开方式 -->
    <template v-if="step === 1">
      <Alert
        class="mb-3"
        type="info"
        show-icon
        message="一个基底指标一次派生一批：按维度＝每个维度列一条（继承＋分组白名单）；按码值＝每个取值一条（继承＋业务过滤，如「华东订单额」）。编码与名称都是预填，下一步逐条可改。"
      />
      <Form layout="vertical">
        <Row :gutter="16">
          <Col :span="12">
            <FormItem label="基底指标" required>
              <Select
                v-model:value="form.baseCode"
                :options="baseOptions"
                show-search
                :filter-option="false"
                placeholder="搜索已上架的原子指标（名称/编码）"
                style="width: 100%"
                @search="searchBase"
                @change="handleBaseChange"
              />
            </FormItem>
          </Col>
          <Col :span="12">
            <FormItem label="指标域">
              <TreeSelect
                v-model:value="form.domainId"
                :tree-data="domainOptions"
                tree-default-expand-all
                placeholder="决定归属（选基底后自动带出）"
                style="width: 100%"
              />
            </FormItem>
          </Col>
          <Col :span="24">
            <FormItem label="展开方式">
              <Radio.Group v-model:value="expandMode" :disabled="!form.baseCode">
                <Radio value="dimension">按维度（一列一条）</Radio>
                <Radio value="value">按码值（一个取值一条）</Radio>
              </Radio.Group>
            </FormItem>
          </Col>
          <Col :span="24">
            <FormItem
              v-if="expandMode === 'dimension'"
              label="维度列（可多选，来自基底取数模型的维度/时间列）"
            >
              <Select
                v-model:value="pickedColumns"
                :options="dimensionOptions"
                mode="multiple"
                allow-clear
                placeholder="选择要展开的维度列"
                style="width: 100%"
                :disabled="!dimensionOptions.length"
              />
            </FormItem>
            <FormItem v-else label="维度列（单选，再按该列的取值档案逐值展开）">
              <Select
                v-model:value="valueColumn"
                :options="dimensionOptions.filter((o) => o.isDimension)"
                placeholder="选择有取值档案的维度列"
                style="width: 100%"
                :disabled="!dimensionOptions.length"
                @change="loadDimValues"
              />
            </FormItem>
          </Col>
        </Row>
        <div v-if="baseHint" class="base-hint">{{ baseHint }}</div>
      </Form>
    </template>

    <!-- ② 逐条改名与编码 -->
    <template v-if="step === 2">
      <Alert
        class="mb-3"
        type="info"
        show-icon
        message="勾一行＝建一个派生指标；编码冲突、维度越界（基底模型没有该列）由后端逐条拒绝并回显原因（不静默改名、不整批回滚）。"
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
        :scroll="{ x: 860, y: 320 }"
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
          <template v-else-if="column.key === 'dimensions'">
            <Select
              v-model:value="record.dimensions"
              :options="dimensionOptions"
              mode="multiple"
              size="small"
              style="width: 100%"
            />
          </template>
          <template v-else-if="column.key === 'filterSql'">
            <Input v-model:value="record.filterSql" size="small" placeholder="如 t.region='01'" />
          </template>
        </template>
      </Table>
      <div class="mt-2 text-xs opacity-70">
        基底「{{ form.baseName }}（{{ form.baseCode }}）」· 模型
        {{ form.baseModelName || '未挂模型' }}
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

  import { getApiErrorMessage } from '/@/api/databridge/http'
  import {
    createMetricsBatchApi,
    getModelDimensionValuesApi,
    getMetricModelApi,
    getMetricsApi,
    type DimValue,
    type MetricBatchResult,
    type MetricDefineBatchItem,
    type MetricItem,
    type MetricModelColumn,
  } from '/@/api/databridge/metric'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { useMetricCodeCheck } from './useMetricCodeCheck'

  const FormItem = Form.Item
  // ant-design-vue 3.2 的 Steps 没有 items 属性（4.x 才有），只能挂 Step 子节点
  const Step = Steps.Step

  const STEP_ITEMS = [{ title: '选基底与展开方式' }, { title: '逐条改名' }, { title: '逐条结果' }]
  /** 与后端 POST /metrics/batch 同口径 */
  const BATCH_MAX = 50

  const emit = defineEmits(['success', 'register'])
  const { createMessage, createConfirm } = useMessage()

  const step = ref(1)
  const submitting = ref(false)
  const expandMode = ref<'dimension' | 'value'>('dimension')
  const baseOptions = ref<{ label: string; value: string }[]>([])
  /** code→指标：下拉是远程搜索的，进第②步取基底名要用它，不能再打一次接口 */
  const baseCache = new Map<string, MetricItem>()
  const domainOptions = ref<any[]>([])
  const columns = ref<MetricModelColumn[]>([])
  const pickedColumns = ref<string[]>([])
  const valueColumn = ref<string | undefined>(undefined)
  const dimValues = ref<DimValue[]>([])
  const baseHint = ref('')

  const form = reactive({
    baseCode: undefined as string | undefined,
    baseModelId: undefined as string | undefined,
    domainId: undefined as string | undefined,
    baseName: '',
    baseModelName: '',
  })

  interface DraftRow {
    _key: string
    source: string
    name: string
    code: string
    dimensions: string[]
    filterSql: string
  }

  const rows = ref<DraftRow[]>([])
  const selectedKeys = ref<string[]>([])
  const batchResult = ref<MetricBatchResult>({ results: [], created: 0, failed: 0 })
  /** 上一次提交用的条目（按 results.index 对齐）——「重试失败项」不能拿界面当前行去猜 */
  const lastItems = ref<MetricDefineBatchItem[]>([])

  /** 参与编码校验与冲突计数的行＝勾选的行 */
  const pickedRows = computed(() =>
    rows.value.filter((row) => selectedKeys.value.includes(row._key)),
  )

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

  const dimensionOptions = computed(() =>
    columns.value
      .filter((c) => ['dimension', 'time'].includes(c.role))
      .map((c) => ({
        label: c.bizName ? `${c.bizName}（${c.columnName}）` : c.columnName,
        value: c.columnName,
        isDimension: c.role === 'dimension',
      })),
  )

  const rowColumns = computed(() => {
    const cols: any[] = [
      { title: '展开依据', dataIndex: 'source', key: 'source', width: 150 },
      { title: '指标名', key: 'name', width: 190 },
      { title: '编码 code', key: 'code', width: 210 },
      // 两种展开都会带维度白名单，就得让它可见可改——不能提交界面看不见的字段
      { title: '维度限定', key: 'dimensions', width: 200 },
      { title: '业务过滤（可选）', key: 'filterSql', width: 200 },
    ]
    return cols
  })

  const resultColumns = [
    { title: '#', dataIndex: 'index', key: 'index', width: 50 },
    { title: '编码', dataIndex: 'code', key: 'code', width: 200 },
    { title: '结果', key: 'ok', width: 90 },
    { title: '说明', dataIndex: 'message', key: 'message', ellipsis: true },
  ]

  const canSubmit = computed(() => {
    if (step.value === 1) return Boolean(form.baseCode && form.domainId)
    if (step.value === 2) return selectedKeys.value.length > 0
    return batchResult.value.failed > 0
  })

  const okText = computed(() => {
    if (step.value === 1) return '预览展开结果'
    return step.value === 2 ? '生成派生指标' : '重新提交失败项'
  })

  /**
   * 编码整形：小写字母开头 + 仅 a-z0-9_，上限 64（后端 CODE_PATTERN 同口径）。
   * 中文码值 slug 后是空的，调用方自己决定兜底（这里不猜，只保证「交得出去」）。
   */
  function fitCode(text: string) {
    const base = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
    const safe = /^[a-z]/.test(base) ? base : `m_${base}`
    return safe.slice(0, 64).replace(/_+$/g, '')
  }

  /** 码值进编码用 value 的 slug，不用中文 label（label 落进编码必被 CODE_PATTERN 判非法） */
  function valueSlug(value: string) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
  }

  /** SQL 字面量里的单引号按标准写法翻倍转义，避免档案值里带引号把 filterSql 拼断 */
  function quoteSql(value: string) {
    return `'${String(value).replace(/'/g, "''")}'`
  }

  async function searchBase(keyword: string) {
    try {
      const page = await getMetricsApi({
        keyword: keyword || undefined,
        type: 'ATOMIC',
        status: 'online',
        page: 1,
        size: 50,
      })
      const items = page?.items || []
      items.forEach((m: MetricItem) => baseCache.set(m.code, m))
      baseOptions.value = items.map((m: MetricItem) => ({
        label: `${m.name}（${m.code}）`,
        value: m.code,
      }))
    } catch {
      baseOptions.value = []
    }
  }

  async function handleBaseChange(baseCode: string) {
    pickedColumns.value = []
    valueColumn.value = undefined
    dimValues.value = []
    rows.value = []
    baseHint.value = ''
    if (!baseCode) return
    const base = baseCache.get(baseCode)
    form.baseName = base?.name || baseCode
    form.domainId = base?.domainId || form.domainId
    const modelId = base?.modelId || (base?.defineParams || {}).modelId
    form.baseModelId = modelId
    if (!modelId) {
      columns.value = []
      form.baseModelName = ''
      baseHint.value = '该原子指标没有挂取数模型（跨模型复合？），列不出可用维度，请改用单条新建。'
      return
    }
    try {
      const detail = await getMetricModelApi(modelId)
      columns.value = detail?.columns || []
      form.baseModelName = detail?.name || ''
      if (!dimensionOptions.value.length) {
        baseHint.value = `模型「${detail?.name}」没有登记维度/时间列（角色=维度的字段），派生不出东西来。先去建模页把列角色标成维度。`
        return
      }
      baseHint.value = `基底模型「${detail?.name}」有 ${dimensionOptions.value.length} 个维度/时间列可用；后端还会按这份列清单校验维度越界。`
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '基底模型字段加载失败'))
    }
  }

  async function loadDimValues(columnName: string) {
    dimValues.value = []
    if (!columnName || !form.baseModelId) return
    try {
      const res = await getModelDimensionValuesApi(form.baseModelId, { columnName })
      const hit = (res?.columns || []).find((c) => c.columnName === columnName)
      dimValues.value = (hit?.values || []).filter((v) => !v.stale)
      if (!dimValues.value.length) {
        baseHint.value = `列「${columnName}」还没有取值档案（或全是库里已消失的值）。去建模页「维度取值」先探查/登记，再来按码值展开。`
        return
      }
      baseHint.value = `按码值展开 ${dimValues.value.length} 条（已消失的旧值不展开）；编码后缀取档案 value 的字母形态，中文名走名称列。`
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '维度取值档案加载失败'))
    }
  }

  /** 第①步的选择折算成草稿行：进/退步骤都重算，保证行内容与当前选择一致 */
  function buildRows() {
    const base = form.baseCode || 'base'
    if (expandMode.value === 'value') {
      const col = valueColumn.value
      if (!col || !dimValues.value.length) return []
      return dimValues.value.map((v, i) => {
        const slug = valueSlug(v.value)
        return {
          _key: `v:${col}:${v.value}`,
          source: `${col} = ${v.value}${v.label ? `（${v.label}）` : ''}`,
          name: `${form.baseName}（${v.label || v.value}）`,
          code: fitCode(`${base}_${slug || `v${i + 1}`}`),
          dimensions: [col],
          filterSql: `t.${col}=${quoteSql(v.value)}`,
        }
      })
    }
    return pickedColumns.value.map((col) => ({
      _key: `d:${col}`,
      source: dimensionOptions.value.find((o) => o.value === col)?.label || col,
      name: `按${dimensionOptions.value.find((o) => o.value === col)?.label || col}分${
        form.baseName
      }`,
      code: fitCode(`${base}_by_${col}`),
      dimensions: [col],
      filterSql: '',
    }))
  }

  function gotoPreview() {
    const next = buildRows()
    if (!next.length) {
      createMessage.warning(
        expandMode.value === 'value'
          ? '请先选一个有取值档案的维度列（档案为空时去建模页探查/登记）'
          : '请至少勾选一个维度列',
      )
      return
    }
    if (next.length > BATCH_MAX) {
      createMessage.warning(`展开出 ${next.length} 条，单次批量上限 ${BATCH_MAX} 条，请收窄选择`)
      return
    }
    rows.value = next
    selectedKeys.value = next.map((r) => r._key)
    step.value = 2
    // 换了一批行：旧的成败留痕与新行无关，整批重查一次占用
    resetCodeChecks()
    void refreshAllCodes()
  }

  async function backToEditCodes() {
    step.value = 2
    await refreshAllCodes()
  }

  function buildItems(picked: DraftRow[]): MetricDefineBatchItem[] {
    return picked.map((row) => ({
      code: row.code.trim(),
      name: row.name.trim(),
      domainId: form.domainId as string,
      defineType: 'METRIC',
      defineParams: {
        // 契约：baseMetricId 填基底的 code，不是 id；expr 留空由服务端补成 ${基底code}
        baseMetricId: form.baseCode as string,
        dimensions: row.dimensions.length ? row.dimensions : undefined,
        filterSql: row.filterSql.trim() || undefined,
      },
      status: 'online',
    }))
  }

  async function submitItems(items: MetricDefineBatchItem[]) {
    submitting.value = true
    lastItems.value = items
    try {
      batchResult.value = await createMetricsBatchApi(items)
      recordSubmitOutcome(batchResult.value.results || [])
      step.value = 3
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '批量派生失败'))
    } finally {
      submitting.value = false
    }
  }

  async function handleSubmit() {
    if (step.value === 1) {
      if (!form.baseCode) {
        createMessage.warning('请先选一个基底指标')
        return
      }
      if (!form.domainId) {
        createMessage.warning('请选择指标域')
        return
      }
      gotoPreview()
      return
    }
    if (step.value === 2) {
      const picked = pickedRows.value
      if (!picked.length) {
        createMessage.warning('至少勾选一行')
        return
      }
      const conflicts = codeConflictRows.value.length
      if (conflicts) {
        // 不拦死：后端才是权威，前端只提示「这几条会被逐条拒」
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
  // 第②步之前换展开方式/维度列/码值：行还没提交过，直接按新选择重算，别让旧行留着
  watch([expandMode, pickedColumns, valueColumn, dimValues], () => {
    if (step.value === 1) rows.value = buildRows()
  })

  const [registerModal] = useModalInner(async (data) => {
    step.value = 1
    expandMode.value = 'dimension'
    rows.value = []
    selectedKeys.value = []
    columns.value = []
    pickedColumns.value = []
    valueColumn.value = undefined
    dimValues.value = []
    baseHint.value = ''
    batchResult.value = { results: [], created: 0, failed: 0 }
    lastItems.value = []
    resetCodeChecks()
    form.baseCode = undefined
    form.baseModelId = undefined
    form.baseName = ''
    form.baseModelName = ''
    form.domainId = undefined
    domainOptions.value = data?.domainOptions || []
    await searchBase('')
  })
</script>

<style lang="less" scoped>
  .base-hint {
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
