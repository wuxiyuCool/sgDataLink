<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="`维度取值与码值登记 · ${modelName}`"
    :width="880"
    :min-height="360"
    :mask-closable="false"
    :footer="null"
  >
    <Alert
      class="mb-3"
      type="warning"
      show-icon
      message="探查会向源库发一条 GROUP BY 取值 SQL（只读）；取值是真实业务数据，是否进问数 prompt 由「系统配置 → 候选值进问数 Prompt」控制，默认关。"
    />

    <div class="mb-3 flex items-center gap-2">
      <span class="text-xs opacity-70">维度列</span>
      <Select
        v-model:value="columnName"
        :options="columnOptions"
        style="width: 260px"
        @change="loadArchive"
      />
      <Button :loading="profiling" type="primary" @click="handleProfile">
        <Icon icon="ant-design:radar-chart-outlined" class="mr-1" />探查取值
      </Button>
      <Button :disabled="!values.length" :loading="saving" @click="handleSaveLabels"
        >保存业务名</Button
      >
      <Popconfirm title="清空该列在平台里的取值档案？（不影响源库数据）" @confirm="handleClear">
        <Button danger :disabled="!values.length">清空档案</Button>
      </Popconfirm>
      <span v-if="profiledAt" class="text-xs opacity-60"
        >最近探查 {{ formatTime(profiledAt) }}</span
      >
    </div>

    <Alert
      v-if="highCardinality"
      class="mb-3"
      type="error"
      show-icon
      :message="`该列去重后有 ${distinctCount} 个值，超过基数保护线（默认 200），平台不取值——这类列（用户ID、流水号、时间戳）进词典既没意义又会压库。`"
    />

    <Table
      :columns="tableColumns"
      :data-source="values"
      :loading="loading"
      :pagination="{ pageSize: 10, showTotal: (t: number) => `共 ${t} 个取值` }"
      row-key="value"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'label'">
          <Input v-model:value="record.label" size="small" placeholder="业务名，如 华东" />
        </template>
        <template v-else-if="column.key === 'source'">
          <Tag :color="record.source === 'manual' ? 'purple' : 'default'">
            {{ record.source === 'manual' ? '人工补录' : '探查' }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'stale'">
          <Tooltip v-if="record.stale" title="本次探查已见不到该值，仍保留以便历史数据可被解释">
            <Tag color="warning">已失效</Tag>
          </Tooltip>
          <span v-else class="text-xs opacity-40">—</span>
        </template>
      </template>
    </Table>

    <div class="mt-3 text-xs opacity-70">
      为什么需要它：库里存
      <code>E1</code>、业务说「华东」时，问数只能靠这份对应关系把用户话里的值换成真实值；
      登记后即使「候选值进
      prompt」关着，平台也会在解析后做同样的替换（替换发生在服务端，不外发数据）。
      没登记的取值会原样下发并在问数结果里提示「不在取值档案里」，那是补录线索。
    </div>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, ref } from 'vue'

  import { Alert, Button, Input, Popconfirm, Select, Table, Tag, Tooltip } from 'ant-design-vue'

  import {
    clearModelDimensionValuesApi,
    getModelDimensionValuesApi,
    profileModelDimensionsApi,
    saveModelDimensionValuesApi,
    type DimValue,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { formatTime } from '../data'

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const modelId = ref('')
  const modelName = ref('')
  const dimColumns = ref<{ columnName: string; bizName?: string }[]>([])
  const columnName = ref<string>('')
  const values = ref<DimValue[]>([])
  const profiledAt = ref('')
  const highCardinality = ref(false)
  const distinctCount = ref(0)
  const loading = ref(false)
  const profiling = ref(false)
  const saving = ref(false)

  const columnOptions = computed(() =>
    dimColumns.value.map((c) => ({
      label: c.bizName ? `${c.bizName}（${c.columnName}）` : c.columnName,
      value: c.columnName,
    })),
  )

  const tableColumns = [
    { title: '库里真实值', dataIndex: 'value', key: 'value', width: 220, ellipsis: true },
    { title: '出现行数', dataIndex: 'hits', key: 'hits', width: 100 },
    { title: '来源', key: 'source', width: 100 },
    { title: '业务名（登记）', key: 'label', width: 220 },
    { title: '状态', key: 'stale', width: 90 },
  ]

  async function loadArchive() {
    if (!columnName.value) return
    loading.value = true
    try {
      const result = await getModelDimensionValuesApi(modelId.value, {
        columnName: columnName.value,
      })
      const section = (result.columns || []).find((c) => c.columnName === columnName.value)
      values.value = (section?.values || []).map((v) => ({ ...v }))
      highCardinality.value = false
      distinctCount.value = 0
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '取值档案读取失败'))
    } finally {
      loading.value = false
    }
  }

  async function handleProfile() {
    if (!columnName.value) return
    profiling.value = true
    try {
      const result = await profileModelDimensionsApi(modelId.value, { columns: [columnName.value] })
      const col = (result.columns || []).find((c) => c.columnName === columnName.value) || {
        values: [],
      }
      values.value = (col.values || []).map((v) => ({ ...v }))
      highCardinality.value = col.highCardinality === true
      distinctCount.value = col.distinctCount || 0
      profiledAt.value = result.profiledAt
      emit('success')
      if (highCardinality.value) createMessage.warning('该列基数过高，平台不取值')
      else createMessage.success(`已探查 ${values.value.length} 个取值`)
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '探查失败（需 DB_DRIVER=mysql 且引擎可达）'))
    } finally {
      profiling.value = false
    }
  }

  async function handleSaveLabels() {
    saving.value = true
    try {
      const result = await saveModelDimensionValuesApi(modelId.value, {
        columnName: columnName.value,
        values: values.value.map((v) => ({ value: v.value, label: v.label || '' })),
      })
      values.value = (result.values || []).map((v) => ({ ...v }))
      createMessage.success('业务名已登记')
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '登记失败'))
    } finally {
      saving.value = false
    }
  }

  async function handleClear() {
    try {
      await clearModelDimensionValuesApi(modelId.value, columnName.value)
      values.value = []
      createMessage.success('已清空该列档案')
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '清空失败'))
    }
  }

  const [registerModal] = useModalInner(async (data) => {
    modelId.value = data?.modelId || ''
    modelName.value = data?.modelName || ''
    dimColumns.value = data?.columns || []
    columnName.value = data?.columnName || dimColumns.value[0]?.columnName || ''
    values.value = []
    profiledAt.value = ''
    highCardinality.value = false
    if (columnName.value) await loadArchive()
  })
</script>
