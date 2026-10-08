<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? `编辑任务：${taskName}` : '新建清洗汇总任务'"
    :width="880"
    :min-height="380"
    :mask-closable="false"
    :confirm-loading="submitting"
    ok-text="保存"
    @ok="handleSubmit"
  >
    <Form :model="form" layout="vertical">
      <Row :gutter="16">
        <Col :span="12">
          <FormItem label="任务名称" required>
            <Input v-model:value="form.name" placeholder="如 交易域指标日汇总" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="源模型（指标物化来源，全部指标须同挂此模型）" required>
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
          <FormItem label="汇总指标（跨模型复合会被后端拒绝）" required>
            <Select
              v-model:value="form.metricIds"
              :options="metricOptions"
              mode="multiple"
              show-search
              :filter-option="filterOption"
              placeholder="选择要物化的指标（含复合）"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="分组维度（源模型维度列）">
            <Select v-model:value="form.dimensionColumnIds" :options="dimensionOptions" mode="multiple" allow-clear />
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
                <InputNumber v-model:value="recentPeriod" :min="1" :max="3650" style="width: 90px" />
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
              <RangePicker v-if="timeMode === 'BETWEEN'" v-model:value="betweenRange" value-format="YYYY-MM-DD" />
            </Space>
          </FormItem>
        </Col>
      </Row>

      <Divider orientation="left" style="margin-top: 4px">清洗规则（filter/fill/rename；去重请放上游同步任务）</Divider>
      <div v-for="(rule, index) in form.cleanRules" :key="index" class="rule-row">
        <Select
          v-model:value="rule.type"
          :options="[
            { label: '过滤 SQL', value: 'filter' },
            { label: '空值填充', value: 'fill' },
            { label: '列改名', value: 'rename' },
          ]"
          style="width: 120px"
          @change="() => clearRuleBody(rule)"
        />
        <template v-if="rule.type === 'filter'">
          <Input v-model:value="rule.sql" placeholder="t.status='PAID'" style="flex: 1" />
        </template>
        <template v-else-if="rule.type === 'fill'">
          <Select v-model:value="rule.column" :options="dimensionOptions" placeholder="列" style="width: 160px" />
          <Input v-model:value="rule.value" placeholder="填充值" style="width: 160px" />
        </template>
        <template v-else>
          <Select v-model:value="rule.column" :options="dimensionOptions" placeholder="列" style="width: 160px" />
          <Input v-model:value="rule.to" placeholder="新列名（标识符）" style="width: 160px" />
        </template>
        <Button type="link" danger @click="form.cleanRules.splice(index, 1)">删除</Button>
      </div>
      <Button size="small" type="dashed" block @click="addRule">+ 添加规则</Button>

      <Divider orientation="left" style="margin-top: 12px">目标与调度</Divider>
      <Row :gutter="16">
        <Col :span="12">
          <FormItem label="目标数据源（物化红线：必须与指标同源）">
            <Input :value="targetDsLabel" disabled />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="目标表" required>
            <Input v-model:value="form.targetTable" placeholder="新表名（不存在时任务执行自动 CREATE）" />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem label="写入模式">
            <Select
              v-model:value="form.writeMode"
              :options="[
                { label: '覆盖 overwrite', value: 'overwrite' },
                { label: '追加 append', value: 'append' },
                { label: '幂等 upsert（仅 MySQL）', value: 'upsert' },
              ]"
            />
          </FormItem>
        </Col>
        <Col :span="8">
          <FormItem v-if="form.writeMode === 'upsert'" label="upsert 主键列">
            <Select v-model:value="form.upsertKeys" :options="dimensionOptions" mode="multiple" />
          </FormItem>
        </Col>
        <Col :span="8">
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
        <Col :span="12">
          <FormItem label="调度 Cron（6 位：秒 分 时 日 月 周；留空=仅手动）">
            <Input v-model:value="form.scheduleCron" placeholder="如 0 30 2 * * ?" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="备注">
            <Input v-model:value="form.remark" />
          </FormItem>
        </Col>
      </Row>

      <div class="mt-2">
        <Button :loading="previewLoading" @click="handlePreview">保存前 Preview 语句</Button>
        <span v-if="!isUpdate" style="margin-left: 8px; color: #999; font-size: 12px">（preview 不落库，仅查看将要执行的 SQL）</span>
      </div>
      <pre v-if="previewStatements.length" class="sql-block mt-2">{{ previewStatements.join('\n\n') }}</pre>
    </Form>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref } from 'vue'

  import { Button, Col, DatePicker, Divider, Form, Input, InputNumber, Row, Select, Space } from 'ant-design-vue'

  import {
    createMetricTaskApi,
    getMetricModelsApi,
    getMetricModelApi,
    getMetricsApi,
    previewMetricTaskApi,
    updateMetricTaskApi,
    type MetricTask,
    type MetricTaskCleanRule,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  const FormItem = Form.Item
  const RangePicker = DatePicker.RangePicker

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const isUpdate = ref(false)
  const submitting = ref(false)
  const previewLoading = ref(false)
  const taskName = ref('')

  const modelOptions = ref<{ label: string; value: string }[]>([])
  const metricOptions = ref<{ label: string; value: string }[]>([])
  const dimensionOptions = ref<{ label: string; value: string }[]>([])
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
    targetDatasourceId: undefined as string | undefined,
    targetTable: '',
    writeMode: 'upsert' as 'overwrite' | 'append' | 'upsert',
    upsertKeys: [] as string[],
    scheduleCron: '',
    status: 'online' as 'online' | 'offline',
    remark: '',
  })

  const targetDsLabel = computed(() => (sourceDs.value ? `${sourceDs.value.name}（同源锁定）` : '选择源模型后自动带出'))

  function filterOption(input: string, option: any) {
    return String(option?.label || '').toLowerCase().includes(input.toLowerCase())
  }

  async function loadModels() {
    if (modelOptions.value.length) return
    try {
      const page = await getMetricModelsApi({ page: 1, size: 200 })
      modelOptions.value = (page?.items || []).map((m) => ({ label: `${m.name}（${m.tableName}）`, value: m.id }))
    } catch {
      modelOptions.value = []
    }
  }

  async function loadMetrics() {
    try {
      const page = await getMetricsApi({ page: 1, size: 300, status: 'online' })
      metricOptions.value = (page?.items || []).map((m) => ({ label: `${m.name}（${m.code}｜${m.type}）`, value: m.id }))
    } catch {
      metricOptions.value = []
    }
  }

  async function handleSourceChange(modelId: string) {
    dimensionOptions.value = []
    sourceDs.value = null
    form.targetDatasourceId = undefined
    if (!modelId) return
    try {
      const detail = await getMetricModelApi(modelId)
      dimensionOptions.value = (detail?.columns || [])
        .filter((c) => ['dimension', 'time'].includes(c.role))
        .map((c) => ({ label: `${c.bizName || c.columnName}（${c.columnName}）`, value: c.columnName }))
      sourceDs.value = { id: detail?.datasourceId || '', name: (detail as any).datasourceName || detail?.datasourceId || '' }
      form.targetDatasourceId = detail?.datasourceId
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
    if (timeMode.value === 'RECENT') return { mode: 'RECENT', unit: recentUnit.value, period: recentPeriod.value }
    if (!betweenRange.value || betweenRange.value.length !== 2) return null
    return { mode: 'BETWEEN', start: betweenRange.value[0], end: betweenRange.value[1] }
  }

  function buildPayload(): Partial<MetricTask> {
    return {
      name: form.name.trim(),
      domainId: form.domainId,
      sourceModelId: form.sourceModelId,
      metricIds: form.metricIds,
      dimensionColumnIds: form.dimensionColumnIds,
      cleanRules: form.cleanRules.filter((r) => r.type),
      timePreset: buildTimePreset(),
      targetDatasourceId: form.targetDatasourceId,
      targetTable: form.targetTable.trim(),
      writeMode: form.writeMode,
      upsertKeys: form.writeMode === 'upsert' ? form.upsertKeys : undefined,
      scheduleCron: form.scheduleCron.trim(),
      status: form.status,
      remark: form.remark,
    }
  }

  async function handlePreview() {
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

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    previewStatements.value = []
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
      form.targetTable = record.targetTable
      form.writeMode = record.writeMode
      form.upsertKeys = [...(record.upsertKeys || [])]
      form.scheduleCron = record.scheduleCron || ''
      form.status = record.status
      form.remark = record.remark || ''
      form.sourceModelId = record.sourceModelId
      await handleSourceChange(record.sourceModelId)
      form.targetDatasourceId = record.targetDatasourceId || form.targetDatasourceId
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
      taskName.value = ''
      form.id = ''
      form.name = ''
      form.domainId = undefined
      form.sourceModelId = undefined
      form.metricIds = []
      form.dimensionColumnIds = []
      form.cleanRules = []
      form.targetDatasourceId = undefined
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
      sourceDs.value = null
    }
  })

  async function handleSubmit() {
    if (!form.name.trim() || !form.sourceModelId || !form.metricIds.length || !form.targetTable.trim()) {
      createMessage.warning('名称/源模型/指标/目标表必填')
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
  .rule-row {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: #f6f8fa;
    padding: 8px 12px;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
