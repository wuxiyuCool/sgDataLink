<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? `编辑任务：${taskName}` : '新建清洗汇总任务'"
    :width="1180"
    :min-height="420"
    :mask-closable="false"
    :confirm-loading="submitting"
    can-full-screen
    ok-text="保存"
    @ok="handleSubmit"
  >
    <Row :gutter="16" class="task-layout">
      <!-- 左栏：怎么配 -->
      <Col :span="14" class="task-form">
        <Form :model="form" layout="vertical">
          <BasicTitle class="sec" span :help-message="ALIGN_HELP">对齐模式</BasicTitle>
          <div class="align-cards">
            <div
              v-for="opt in alignCards"
              :key="opt.value"
              class="align-card"
              :class="{ 'align-card--on': form.align === opt.value }"
              @click="handleAlignChange(opt.value)"
            >
              <div class="align-card__head">
                <Icon :icon="opt.icon" :size="15" class="align-card__icon" />
                <span class="align-card__title">{{ opt.title }}</span>
                <Icon
                  v-if="form.align === opt.value"
                  icon="ant-design:check-circle-filled"
                  :size="15"
                  class="align-card__check"
                />
              </div>
              <div class="align-card__desc">{{ opt.desc }}</div>
            </div>
          </div>

          <BasicTitle class="sec" span>指标与窗口</BasicTitle>
          <Row :gutter="12">
            <Col :span="12">
              <FormItem label="任务名称" required>
                <Input v-model:value="form.name" placeholder="如 交易域指标月宽表" />
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem
                v-if="form.align === 'time'"
                label="目标时间粒度"
                required
                :help="GRAIN_HELP"
              >
                <Select v-model:value="form.timeGrain" :options="grainOptions" />
              </FormItem>
              <FormItem v-else label="分组维度（即聚合粒度）">
                <Select
                  v-model:value="form.dimensionColumnIds"
                  :options="dimensionOptions"
                  mode="multiple"
                  allow-clear
                  placeholder="不勾=所有指标聚成一整段合计"
                />
              </FormItem>
            </Col>
            <Col :span="24">
              <FormItem :label="sourceModelLabel" required>
                <Select
                  v-model:value="form.sourceModelId"
                  :options="modelOptions"
                  show-search
                  :filter-option="filterOption"
                  placeholder="选择数据建模里的源模型"
                  @change="handleSourceChange"
                />
              </FormItem>
            </Col>
            <Col :span="24">
              <FormItem :label="metricLabel" required>
                <Select
                  v-model:value="form.metricIds"
                  :options="metricOptions"
                  mode="multiple"
                  show-search
                  :filter-option="filterOption"
                  placeholder="选择要物化的指标"
                />
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="时间窗口">
                <Space wrap>
                  <Select
                    v-model:value="timeMode"
                    :options="[
                      { label: '不预设（全量）', value: 'none' },
                      { label: '最近 N', value: 'RECENT' },
                      { label: '固定区间', value: 'BETWEEN' },
                    ]"
                    style="width: 130px"
                  />
                  <template v-if="timeMode === 'RECENT'">
                    <InputNumber
                      v-model:value="recentPeriod"
                      :min="1"
                      :max="3650"
                      style="width: 90px"
                    />
                    <Select
                      v-model:value="recentUnit"
                      :options="[
                        { label: '天', value: 'DAY' },
                        { label: '周', value: 'WEEK' },
                        { label: '月', value: 'MONTH' },
                      ]"
                      style="width: 80px"
                    />
                  </template>
                  <RangePicker
                    v-if="timeMode === 'BETWEEN'"
                    v-model:value="betweenRange"
                    value-format="YYYY-MM-DD"
                  />
                </Space>
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="状态">
                <Select
                  v-model:value="form.status"
                  :options="[
                    { label: '启用调度', value: 'online' },
                    { label: '停用', value: 'offline' },
                  ]"
                />
              </FormItem>
            </Col>
          </Row>

          <BasicTitle class="sec" span :help-message="RULE_HELP">清洗规则</BasicTitle>
          <div v-if="!form.cleanRules.length" class="empty-line">暂无规则</div>
          <div v-for="(rule, index) in form.cleanRules" :key="index" class="rule-row">
            <Select
              v-model:value="rule.type"
              :options="ruleTypeOptions"
              style="width: 128px"
              @change="() => clearRuleBody(rule)"
            />
            <Input
              v-if="rule.type === 'filter'"
              v-model:value="rule.sql"
              placeholder="t.status='PAID'"
              style="flex: 1"
            />
            <template v-else-if="rule.type === 'fill'">
              <Select
                v-model:value="rule.column"
                :options="dimensionOptions"
                placeholder="列"
                style="width: 148px"
              />
              <Input v-model:value="rule.value" placeholder="填充值" style="width: 148px" />
            </template>
            <template v-else>
              <Select
                v-model:value="rule.column"
                :options="form.align === 'time' ? timeColumnOptions : dimensionOptions"
                :placeholder="form.align === 'time' ? '时间列' : '列'"
                style="width: 148px"
              />
              <Input
                v-model:value="rule.to"
                :placeholder="form.align === 'time' ? '对齐键名（默认 stat_period）' : '新列名'"
                style="width: 168px"
              />
            </template>
            <Button type="text" danger size="small" @click="form.cleanRules.splice(index, 1)">
              <Icon icon="ant-design:delete-outlined" :size="14" />
            </Button>
          </div>
          <Button size="small" type="dashed" block @click="addRule">
            <Icon icon="ant-design:plus-outlined" class="mr-1" />添加规则
          </Button>

          <Alert
            v-if="targetDsType === 'oracle'"
            type="warning"
            show-icon
            style="margin: 4px 0 12px"
            message="Oracle 目标方言：日期 TO_DATE、粒度截断 TO_CHAR、行数 ROWNUM、留痕列 ETL_TIME，幂等 upsert 走 MERGE INTO；「空值填充」不能填空字符串（Oracle 空串等价 NULL），请填实际占位如 -"
          />
          <Alert
            v-else-if="targetDsType === 'mysql'"
            type="info"
            show-icon
            style="margin: 4px 0 12px"
            message="MySQL 目标方言：日期用字符串字面量、粒度截断用 DATE_FORMAT/YEARWEEK，幂等 upsert 走 ON DUPLICATE KEY UPDATE"
          />

          <BasicTitle class="sec" span :help-message="TARGET_HELP">目标与调度</BasicTitle>
          <Row :gutter="12">
            <Col :span="12">
              <FormItem label="目标数据源">
                <div class="ds-line">
                  <Icon icon="ant-design:database-outlined" :size="14" />
                  <span>{{ targetDsLabel }}</span>
                </div>
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="目标表来源">
                <RadioGroup
                  v-model:value="targetMode"
                  :options="targetModeOptions"
                  option-type="button"
                />
              </FormItem>
            </Col>
            <Col v-if="targetMode === 'model'" :span="24">
              <FormItem label="目标建模表" required>
                <Select
                  v-model:value="form.targetModelId"
                  :options="targetModelOptions"
                  show-search
                  :filter-option="filterOption"
                  placeholder="只列出本数据源下已启用的模型"
                />
                <div class="field-tip">
                  表名与字段都以这张建模表为准，任务不会自动建表、也不会自动加列。
                  <Button type="link" size="small" @click="gotoCreateModel">去建模页新建</Button>
                </div>
              </FormItem>
            </Col>
            <Col v-else :span="24">
              <FormItem label="目标表名（执行时自动 CREATE）" required>
                <Input v-model:value="form.targetTable" placeholder="如 dm_demo_ads_daily" />
                <div class="field-tip"
                  >这是存量任务的旧行为（平台自动建表并带留痕列），新任务建议改选建模表。</div
                >
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem label="写入模式">
                <Select v-model:value="form.writeMode" :options="writeModeOptions" />
              </FormItem>
            </Col>
            <Col :span="12">
              <FormItem v-if="form.writeMode === 'upsert'" label="upsert 冲突键">
                <Input :value="upsertKeyHint" disabled />
              </FormItem>
              <FormItem v-else label="调度 Cron（6 位）">
                <Input v-model:value="form.scheduleCron" placeholder="0 30 2 * * ?，留空=仅手动" />
              </FormItem>
            </Col>
            <Col v-if="form.writeMode === 'upsert'" :span="12">
              <FormItem label="调度 Cron（6 位）">
                <Input v-model:value="form.scheduleCron" placeholder="0 30 2 * * ?，留空=仅手动" />
              </FormItem>
            </Col>
            <Col :span="24">
              <FormItem label="备注">
                <Input v-model:value="form.remark" />
              </FormItem>
            </Col>
          </Row>
        </Form>
      </Col>

      <!-- 右栏：配完会得到什么（跟着左侧选择实时刷新） -->
      <Col :span="10">
        <div class="preview-pane">
          <div class="preview-pane__head">
            <BasicTitle class="sec sec--tight" span>目标表结构</BasicTitle>
            <span v-if="schemaLoading" class="preview-pane__loading">生成中…</span>
          </div>

          <div class="preview-tags">
            <Tag :color="targetSchema ? 'blue' : 'default'">{{ dialectLabel }}</Tag>
            <Tag v-if="targetSchema && targetSchema.autoCreate" color="green">自动建表</Tag>
            <Tag v-else-if="targetSchema" color="cyan">建模表 · {{ targetSchema.table }}</Tag>
            <Tag v-if="targetSchema && targetSchema.align === 'time'" color="purple">
              时间宽表 · {{ targetSchema.timeGrain }}
            </Tag>
          </div>

          <Alert v-if="targetGapText" type="error" show-icon :message="targetGapText">
            <template #description>
              <div>
                平台不会替目标表加列（结构权威在数据建模），补完回来重新保存即可。
                <Button type="link" size="small" @click="gotoModelColumns">去建模页补列</Button>
              </div>
            </template>
          </Alert>
          <Alert v-else-if="schemaError" type="warning" show-icon :message="schemaError" />
          <Alert
            v-else-if="targetSchema && form.writeMode === 'upsert' && !targetSchema.autoCreate"
            type="info"
            show-icon
            message="幂等刷新要求目标表自身有主键或唯一键（平台不校验物理约束，只按对齐键出语句）。"
          />

          <div v-if="wideGroups.length > 1" class="group-list">
            <div class="group-list__title">
              <Icon icon="ant-design:partition-outlined" :size="13" />
              {{ wideGroups.length }} 个源模型，各出一个子查询
            </div>
            <div v-for="g in wideGroups" :key="g.modelId" class="group-item">
              <div class="group-item__head">
                <span class="group-item__name">{{ g.modelName }}</span>
                <span class="group-item__col">{{ g.fromTable }}.{{ g.timeColumn }}</span>
              </div>
              <div class="group-item__metrics">
                <Tag v-for="m in g.metrics" :key="m.target" :bordered="false">{{ m.target }}</Tag>
              </div>
            </div>
          </div>

          <Table
            :columns="schemaColumns"
            :data-source="schemaRows"
            :pagination="false"
            size="small"
            row-key="name"
            :scroll="{ y: 240 }"
            :locale="{ emptyText: '选完源模型与指标后，这里实时列出要写入的字段' }"
          />

          <Collapse v-if="sqlBlocks.length" ghost class="sql-collapse">
            <CollapsePanel v-for="block in sqlBlocks" :key="block.label" :header="block.label">
              <div class="sql-box">
                <Button size="small" class="sql-box__copy" @click="copy(block.sql)">复制</Button>
                <pre class="sql-box__text">{{ block.sql }}</pre>
              </div>
            </CollapsePanel>
          </Collapse>

          <div class="preview-pane__foot">
            <Button :loading="previewLoading" block @click="handlePreview"
              >保存前 Preview 全部语句</Button
            >
          </div>
          <pre v-if="previewStatements.length" class="sql-block">{{
            previewStatements.join('\n\n')
          }}</pre>
        </div>
      </Col>
    </Row>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref, watch } from 'vue'

  import {
    Alert,
    Button,
    Col,
    Collapse,
    DatePicker,
    Form,
    Input,
    InputNumber,
    Radio,
    Row,
    Select,
    Space,
    Table,
    Tag,
  } from 'ant-design-vue'
  import { useRouter } from 'vue-router'

  import { getDatasourceApi } from '/@/api/databridge/datasource'

  import {
    createMetricTaskApi,
    getMetricModelsApi,
    getMetricModelApi,
    getMetricsApi,
    previewMetricTaskApi,
    previewMetricTaskSchemaApi,
    updateMetricTaskApi,
    type MetricTask,
    type MetricTaskCleanRule,
    type MetricTaskPlanGroup,
    type MetricTaskTargetSchema,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicTitle } from '/@/components/Basic'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useCopyToClipboard } from '/@/hooks/web/useCopyToClipboard'
  import { useMessage } from '/@/hooks/web/useMessage'

  const FormItem = Form.Item
  const RangePicker = DatePicker.RangePicker
  const RadioGroup = Radio.Group
  const CollapsePanel = Collapse.Panel

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()
  const router = useRouter()
  const { clipboardRef, isSuccessRef } = useCopyToClipboard()

  const ALIGN_HELP =
    '同模型聚合＝全部指标挂同一个源模型，可按任意维度分组；时间宽表＝指标可以来自同一数据源下的多个模型，只按时间粒度对齐拼成一张宽表（此时不能带非时间维度——跨表同维度要先有维度映射，本期不做，以免静默错算）。'
  const GRAIN_HELP =
    '指标可各自声明源粒度（defineParams.timeGrain，不填按天）。目标粒度必须不低于全部指标里最粗的那一档：日→月是再聚合（正确），月→日会把一个月的值摊到每一天（静默错算），保存期会被拒。'
  const RULE_HELP =
    'filter 进 WHERE；fill 给维度列补空值；rename 改目标列名。时间宽表只支持 filter 与「时间列改名」（改的就是对齐键，默认 stat_period）。去重请放上游同步任务。'
  const TARGET_HELP =
    '目标数据源必须与指标同源（单连接物化红线）。目标表结构以数据建模为准：缺列或类型不兼容只报错，任务不自动建表、也不自动加列。'

  const isUpdate = ref(false)
  const submitting = ref(false)
  const previewLoading = ref(false)
  const taskName = ref('')

  const alignCards = [
    {
      value: 'model' as const,
      icon: 'ant-design:group-outlined',
      title: '同模型聚合',
      desc: '指标同挂一个源模型，可按地区、门店等任意维度分组（默认）',
    },
    {
      value: 'time' as const,
      icon: 'ant-design:fund-outlined',
      title: '时间宽表',
      desc: '跨同数据源的多个模型，只按时间粒度对齐拼成一张汇总表',
    },
  ]
  const targetModeOptions = [
    { label: '选建模页的表', value: 'model' },
    { label: '自动建表（存量）', value: 'auto' },
  ]
  const grainOptions = [
    { label: '天 day', value: 'day' },
    { label: '周 week', value: 'week' },
    { label: '月 month', value: 'month' },
    { label: '季 quarter', value: 'quarter' },
    { label: '年 year', value: 'year' },
  ]

  const modelOptions = ref<{ label: string; value: string }[]>([])
  const metricOptions = ref<{ label: string; value: string }[]>([])
  const dimensionOptions = ref<{ label: string; value: string }[]>([])
  const timeColumnOptions = ref<{ label: string; value: string }[]>([])
  /** 目标建模表候选：同数据源 + 已启用（草稿模型的表结构未确认，后端也会拒） */
  const targetModelOptions = ref<{ label: string; value: string }[]>([])
  const sourceDs = ref<{ id: string; name: string } | null>(null)
  const previewStatements = ref<string[]>([])

  const timeMode = ref<'none' | 'RECENT' | 'BETWEEN'>('RECENT')
  const recentPeriod = ref(365)
  const recentUnit = ref('DAY')
  const betweenRange = ref<[string, string] | null>(null)

  const form = reactive({
    id: '',
    name: '',
    domainId: undefined as string | undefined,
    sourceModelId: undefined as string | undefined,
    metricIds: [] as string[],
    dimensionColumnIds: [] as string[],
    cleanRules: [] as MetricTaskCleanRule[],
    align: 'model' as 'model' | 'time',
    timeGrain: 'month' as string,
    targetDatasourceId: undefined as string | undefined,
    targetModelId: undefined as string | undefined,
    targetTable: '',
    writeMode: 'upsert' as 'overwrite' | 'append' | 'upsert',
    upsertKeys: [] as string[],
    scheduleCron: '',
    status: 'online' as 'online' | 'offline',
    remark: '',
  })

  /** 目标表来源：建模表（新任务）/ 自动建表（存量任务保留二期行为） */
  const targetMode = ref<'model' | 'auto'>('model')

  const sourceModelLabel = computed(() =>
    form.align === 'time'
      ? '主源模型（宽表按各指标自己的模型分组）'
      : '源模型（全部指标须同挂此模型）',
  )

  const metricLabel = computed(() =>
    form.align === 'time'
      ? '汇总指标（可跨同源模型，每个模型各出一个子查询）'
      : '汇总指标（跨模型复合会被拒绝）',
  )

  const dialectLabel = computed(() => {
    if (!targetSchema.value) return '方言未定'
    return targetSchema.value.dialect === 'oracle' ? 'Oracle 方言' : 'MySQL 方言'
  })

  const ruleTypeOptions = computed(() =>
    form.align === 'time'
      ? [
          { label: '过滤 SQL', value: 'filter' },
          { label: '时间列改名', value: 'rename' },
        ]
      : [
          { label: '过滤 SQL', value: 'filter' },
          { label: '空值填充', value: 'fill' },
          { label: '列改名', value: 'rename' },
        ],
  )

  const upsertKeyHint = computed(() =>
    form.align === 'time'
      ? 'stat_period（时间对齐键）'
      : form.dimensionColumnIds.length
      ? form.dimensionColumnIds.join('、')
      : '需至少勾选一个维度列',
  )

  const targetDsLabel = computed(() =>
    sourceDs.value ? `${sourceDs.value.name}（同源锁定）` : '选择源模型后自动带出',
  )

  const targetGapText = computed(() => {
    const sc = targetSchema.value
    if (!sc || sc.autoCreate || sc.matched) return ''
    const parts: string[] = []
    const missing = sc.missingColumns || []
    const mismatch = sc.mismatchColumns || []
    if (missing.length)
      parts.push(`缺列：${missing.map((c) => `${c.name}（建议 ${c.suggestType}）`).join('、')}`)
    if (mismatch.length)
      parts.push(
        `类型不兼容：${mismatch
          .map((c) => `${c.name} 需 ${c.expected}，表上是 ${c.actual}`)
          .join('、')}`,
      )
    return parts.join('；')
  })

  const wideGroups = computed<MetricTaskPlanGroup[]>(() => targetSchema.value?.groups || [])
  const schemaRows = computed(() => targetSchema.value?.columns || [])

  const sqlBlocks = computed(() => {
    const sc = targetSchema.value
    if (!sc) return []
    const blocks: { label: string; sql: string }[] = []
    if (sc.createSql) blocks.push({ label: '建表语句（自动建表模式）', sql: sc.createSql })
    if (sc.insertSql) blocks.push({ label: '将要执行的写入语句', sql: sc.insertSql })
    return blocks
  })

  function copy(text: string) {
    clipboardRef.value = text
    if (isSuccessRef.value) createMessage.success('已复制到剪贴板')
    else createMessage.error('复制失败，请手工选取')
  }

  function filterOption(input: string, option: any) {
    return String(option?.label || '')
      .toLowerCase()
      .includes(input.toLowerCase())
  }

  async function loadModels() {
    if (modelOptions.value.length) return
    try {
      const page = await getMetricModelsApi({ page: 1, size: 200 })
      const items = page?.items || []
      modelOptions.value = items.map((m) => ({
        label: `${m.name}（${m.tableName}）`,
        value: m.id,
      }))
      allModels.value = items
    } catch {
      modelOptions.value = []
    }
  }

  const allModels = ref<any[]>([])

  /** 目标建模表候选跟着源数据源走（目标数据源与指标同源是红线） */
  function refreshTargetModelOptions() {
    const dsId = sourceDs.value?.id || ''
    targetModelOptions.value = allModels.value
      .filter((m: any) => m.datasourceId === dsId && m.status === 'online')
      .map((m: any) => ({
        label: `${m.name}（${m.tableName}${m.tableStatus === 'created' ? '' : ' · 表未生成'}）`,
        value: m.id,
      }))
  }

  async function loadMetrics() {
    try {
      const page = await getMetricsApi({ page: 1, size: 300, status: 'online' })
      metricOptions.value = (page?.items || []).map((m) => ({
        label: `${m.name}（${m.code}｜${m.type}）`,
        value: m.id,
      }))
    } catch {
      metricOptions.value = []
    }
  }

  /** 目标数据源方言：决定幂等写法（MySQL ON DUPLICATE / Oracle MERGE）与空串语义 */
  const targetDsType = ref('')

  const writeModeOptions = computed(() => [
    { label: '覆盖 overwrite（先清空）', value: 'overwrite' },
    { label: '追加 append', value: 'append' },
    {
      label:
        targetDsType.value === 'oracle'
          ? '幂等 upsert（MERGE INTO）'
          : '幂等 upsert（ON DUPLICATE）',
      value: 'upsert',
    },
  ])

  async function loadTargetDsType(datasourceId?: string) {
    targetDsType.value = ''
    if (!datasourceId) return
    try {
      const ds = await getDatasourceApi(datasourceId)
      targetDsType.value = (ds as any)?.type || ''
    } catch (error) {
      // 类型拉不到只影响可选性提示，保存时后端仍会按方言拒绝
      targetDsType.value = ''
    }
  }

  function handleAlignChange(align: 'model' | 'time') {
    if (form.align === align) return
    form.align = align
    if (align === 'time') {
      // 时间宽表不认非时间维度：就地清空并只留用得上的规则，别等提交才被后端拒
      form.dimensionColumnIds = []
      form.cleanRules = form.cleanRules.filter((r) => r.type === 'filter' || r.type === 'rename')
    }
  }

  async function handleSourceChange(modelId: string) {
    dimensionOptions.value = []
    timeColumnOptions.value = []
    sourceDs.value = null
    form.targetDatasourceId = undefined
    form.targetModelId = undefined
    targetDsType.value = ''
    if (!modelId) {
      refreshTargetModelOptions()
      return
    }
    try {
      const detail = await getMetricModelApi(modelId)
      const columns = detail?.columns || []
      dimensionOptions.value = columns
        .filter((c) => ['dimension', 'time'].includes(c.role))
        .map((c) => ({
          label: `${c.bizName || c.columnName}（${c.columnName}）`,
          value: c.columnName,
        }))
      timeColumnOptions.value = columns
        .filter((c) => c.role === 'time')
        .map((c) => ({
          label: `${c.bizName || c.columnName}（${c.columnName}）`,
          value: c.columnName,
        }))
      sourceDs.value = {
        id: detail?.datasourceId || '',
        name: (detail as any).datasourceName || detail?.datasourceId || '',
      }
      form.targetDatasourceId = detail?.datasourceId
      await loadTargetDsType(detail?.datasourceId)
      refreshTargetModelOptions()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '源模型详情加载失败'))
    }
  }

  function clearRuleBody(rule: MetricTaskCleanRule) {
    rule.sql = ''
    rule.column = undefined
    rule.value = undefined
    rule.to = undefined
  }

  function addRule() {
    form.cleanRules.push({ type: 'filter', sql: '' })
  }

  function buildTimePreset() {
    if (timeMode.value === 'none') return null
    if (timeMode.value === 'RECENT')
      return { mode: 'RECENT', unit: recentUnit.value, period: recentPeriod.value }
    if (!betweenRange.value || betweenRange.value.length !== 2) return null
    return { mode: 'BETWEEN', start: betweenRange.value[0], end: betweenRange.value[1] }
  }

  function buildPayload(): Partial<MetricTask> {
    const isTime = form.align === 'time'
    return {
      name: form.name.trim(),
      domainId: form.domainId,
      sourceModelId: form.sourceModelId,
      metricIds: form.metricIds,
      // 时间宽表不带非时间维度（后端 40001），提交前就地清空
      dimensionColumnIds: isTime ? [] : form.dimensionColumnIds,
      cleanRules: form.cleanRules.filter((r) => r.type),
      align: form.align,
      timeGrain: isTime ? form.timeGrain : '',
      timePreset: buildTimePreset(),
      targetDatasourceId: form.targetDatasourceId,
      targetModelId: targetMode.value === 'model' ? form.targetModelId || '' : '',
      targetTable: targetMode.value === 'model' ? '' : form.targetTable.trim(),
      writeMode: form.writeMode,
      upsertKeys: form.writeMode === 'upsert' ? form.upsertKeys : undefined,
      scheduleCron: form.scheduleCron.trim(),
      status: form.status,
      remark: form.remark,
    }
  }

  /** 必填项本地校验（保存与 Preview 共用）：返回第一条缺失提示，全齐返回空串 */
  function requiredError(): string {
    if (!form.name.trim()) return '请填写任务名称'
    if (!form.sourceModelId) return '请选择源模型'
    if (!form.metricIds.length) return '请至少勾选一个指标'
    if (form.align === 'time' && !form.timeGrain) return '时间宽表必须指定目标时间粒度'
    if (targetMode.value === 'model' && !form.targetModelId) return '请选择目标建模表'
    if (targetMode.value === 'auto' && !form.targetTable.trim()) return '请填写目标表名'
    return ''
  }

  /** 目标表结构（后端按 buildPlan + 方言层算，含类型/缺列/分组），跟着选择实时刷新 */
  const targetSchema = ref<MetricTaskTargetSchema | null>(null)
  const schemaError = ref('')
  const schemaLoading = ref(false)
  let schemaTimer: ReturnType<typeof setTimeout> | null = null

  const schemaColumns = [
    { title: '字段', dataIndex: 'name', key: 'name', width: 170 },
    { title: '类型（按目标库）', dataIndex: 'type', key: 'type', width: 150 },
    { title: '来源', dataIndex: 'source', key: 'source', width: 70 },
    { title: '说明', dataIndex: 'comment', key: 'comment' },
  ]

  async function refreshTargetSchema() {
    if (requiredError()) {
      targetSchema.value = null
      schemaError.value = ''
      return
    }
    schemaLoading.value = true
    try {
      targetSchema.value = await previewMetricTaskSchemaApi(buildPayload())
      schemaError.value = ''
    } catch (error) {
      targetSchema.value = null
      schemaError.value = getApiErrorMessage(error, '目标表结构生成失败')
    } finally {
      schemaLoading.value = false
    }
  }

  watch(
    () => JSON.stringify(buildPayload()),
    () => {
      if (schemaTimer) clearTimeout(schemaTimer)
      schemaTimer = setTimeout(refreshTargetSchema, 500)
    },
  )

  async function handlePreview() {
    const missing = requiredError()
    if (missing) {
      createMessage.warning(missing)
      return
    }
    previewLoading.value = true
    try {
      const result = await previewMetricTaskApi(buildPayload())
      previewStatements.value = result?.statements || []
      if (!previewStatements.value.length) createMessage.info('无语句生成')
    } catch (error) {
      previewStatements.value = []
      createMessage.error(getApiErrorMessage(error, '配置错误：preview 已被后端拦截'))
    } finally {
      previewLoading.value = false
    }
  }

  function gotoModelColumns() {
    closeModal()
    router.push({ name: 'MetricModels', query: { columnsFor: form.targetModelId } })
  }

  function gotoCreateModel() {
    closeModal()
    router.push({ name: 'MetricModels', query: { createModel: '1' } })
  }

  function resetForm() {
    taskName.value = ''
    form.id = ''
    form.name = ''
    form.domainId = undefined
    form.sourceModelId = undefined
    form.metricIds = []
    form.dimensionColumnIds = []
    form.cleanRules = []
    form.align = 'model'
    form.timeGrain = 'month'
    form.targetDatasourceId = undefined
    form.targetModelId = undefined
    form.targetTable = ''
    form.writeMode = 'upsert'
    form.upsertKeys = []
    form.scheduleCron = ''
    form.status = 'online'
    form.remark = ''
    timeMode.value = 'RECENT'
    recentPeriod.value = 365
    recentUnit.value = 'DAY'
    betweenRange.value = null
    dimensionOptions.value = []
    timeColumnOptions.value = []
    sourceDs.value = null
    targetMode.value = 'model'
  }

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    previewStatements.value = []
    targetSchema.value = null
    schemaError.value = ''
    await Promise.all([loadModels(), loadMetrics()])
    isUpdate.value = !!data?.isUpdate
    const record: MetricTask | undefined = data?.record
    if (record) {
      taskName.value = record.name
      form.id = record.id
      form.name = record.name
      form.domainId = record.domainId
      form.metricIds = [...(record.metricIds || [])]
      form.dimensionColumnIds = [...(record.dimensionColumnIds || [])]
      form.cleanRules = (record.cleanRules || []).map((r) => ({ ...r }))
      form.align = record.align || 'model'
      form.timeGrain = record.timeGrain || 'month'
      form.targetModelId = record.targetModelId || undefined
      form.targetTable = record.targetTable || ''
      targetMode.value = record.targetModelId ? 'model' : 'auto'
      form.writeMode = record.writeMode
      form.upsertKeys = [...(record.upsertKeys || [])]
      form.scheduleCron = record.scheduleCron || ''
      form.status = record.status
      form.remark = record.remark || ''
      form.sourceModelId = record.sourceModelId
      await handleSourceChange(record.sourceModelId)
      form.targetDatasourceId = record.targetDatasourceId || form.targetDatasourceId
      form.targetModelId = record.targetModelId || undefined
      const tp = record.timePreset
      if (!tp) timeMode.value = 'none'
      else if (tp.mode === 'RECENT') {
        timeMode.value = 'RECENT'
        recentUnit.value = tp.unit || 'DAY'
        recentPeriod.value = tp.period || 365
      } else {
        timeMode.value = 'BETWEEN'
        betweenRange.value = [tp.start || '', tp.end || '']
      }
    } else {
      resetForm()
      // 指标广场「建宽表任务」跳过来时带的预选（指标 + 对齐模式 + 粒度）
      const prefill = data?.prefill as
        | { metricIds?: string[]; align?: 'model' | 'time'; timeGrain?: string }
        | undefined
      if (prefill?.metricIds?.length) form.metricIds = [...prefill.metricIds]
      if (prefill?.align) form.align = prefill.align
      if (prefill?.timeGrain) form.timeGrain = prefill.timeGrain
      refreshTargetModelOptions()
    }
  })

  async function handleSubmit() {
    const missing = requiredError()
    if (missing) {
      createMessage.warning(missing)
      return
    }
    if (targetGapText.value) {
      createMessage.warning('目标建模表结构不够，请先补列')
      return
    }
    submitting.value = true
    try {
      const payload = buildPayload()
      if (isUpdate.value && form.id) {
        await updateMetricTaskApi(form.id, payload)
        createMessage.success('任务已更新（保存期完成计划校验）')
      } else {
        await createMetricTaskApi(payload)
        createMessage.success('任务已创建')
      }
      closeModal()
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败（配置错误挡在保存期）'))
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .task-layout {
    align-items: flex-start;
  }

  .sec {
    display: flex;
    margin: 2px 0 10px;
    font-size: 14px;

    &--tight {
      margin-bottom: 0;
    }
  }

  .task-form {
    :deep(.ant-form-item) {
      margin-bottom: 12px;
    }
  }

  .align-cards {
    display: flex;
    gap: 10px;
    margin-bottom: 18px;
  }

  .align-card {
    flex: 1;
    padding: 10px 12px;
    cursor: pointer;
    background: @component-background;
    border: 1px solid @border-color-base;
    border-radius: 6px;
    transition: border-color 0.2s, background 0.2s;

    &:hover {
      border-color: @primary-color-hover;
    }

    &--on {
      background: fade(@primary-color, 6%);
      border-color: @primary-color;
    }

    &__head {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    &__icon {
      color: @primary-color;
    }

    &__title {
      font-weight: 600;
    }

    &__check {
      margin-left: auto;
      color: @primary-color;
    }

    &__desc {
      margin-top: 4px;
      font-size: 12px;
      line-height: 18px;
      color: @text-color-secondary;
    }
  }

  .empty-line {
    margin-bottom: 8px;
    font-size: 12px;
    color: @text-color-secondary;
  }

  .rule-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .ds-line {
    display: flex;
    gap: 6px;
    align-items: center;
    height: 32px;
    padding: 0 10px;
    font-size: 13px;
    background: @background-color-light;
    border: 1px solid @border-color-base;
    border-radius: 4px;
  }

  .field-tip {
    margin-top: 2px;
    font-size: 12px;
    line-height: 18px;
    color: @text-color-secondary;
  }

  .preview-pane {
    position: sticky;
    top: 0;
    padding: 12px 14px;
    background: @component-background;
    border: 1px solid @border-color-split;
    border-radius: 8px;

    &__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    &__loading {
      font-size: 12px;
      color: @text-color-secondary;
    }

    &__foot {
      margin-top: 12px;
    }
  }

  .preview-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }

  .group-list {
    margin-bottom: 10px;
    padding: 8px 10px;
    background: @background-color-light;
    border-radius: 6px;

    &__title {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 12px;
      color: @text-color-secondary;
    }
  }

  .group-item {
    &__head {
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 12px;
    }

    &__name {
      font-weight: 600;
    }

    &__col {
      font-family: Consolas, Monaco, monospace;
      font-size: 11px;
      color: @text-color-secondary;
    }
  }

  .sql-collapse {
    margin-top: 10px;

    :deep(.ant-collapse-header) {
      padding: 6px 0;
      font-size: 12px;
    }

    :deep(.ant-collapse-content-box) {
      padding: 0 0 6px;
    }
  }

  .sql-box {
    position: relative;

    &__copy {
      position: absolute;
      top: 4px;
      right: 6px;
      z-index: 1;
      font-size: 12px;
    }

    &__text {
      max-height: 200px;
      padding: 8px 10px;
      margin: 0;
      overflow: auto;
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-all;
      background: @background-color-light;
      border-radius: 6px;
    }
  }

  .sql-block {
    max-height: 240px;
    padding: 8px 10px;
    margin: 10px 0 0;
    overflow: auto;
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-all;
    background: @background-color-light;
    border-radius: 6px;
  }
</style>
