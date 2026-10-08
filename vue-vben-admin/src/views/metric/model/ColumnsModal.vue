<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="`字段维护：${modelName}`"
    :width="960"
    :min-height="360"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Alert
      class="mb-3"
      type="info"
      show-icon
      message="业务名供智能问数召回（如「地区」）；角色决定可用性：度量列走指标定义，维度列可作分组/过滤，时间列作日期条件。"
    />
    <Spin :spinning="loading">
      <Table
        :columns="readOnlyColumns"
        :data-source="physicalColumns"
        :pagination="false"
        size="small"
        row-key="columnName"
        :scroll="{ y: 360 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'bizName'">
            <Input v-model:value="record.bizName" size="small" placeholder="业务名" />
          </template>
          <template v-else-if="column.key === 'role'">
            <Select v-model:value="record.role" :options="COLUMN_ROLE_OPTIONS" size="small" style="width: 110px" />
          </template>
          <template v-else-if="column.key === 'aggDefault'">
            <Select
              v-model:value="record.aggDefault"
              :options="AGG_OPTIONS"
              size="small"
              style="width: 150px"
              :disabled="record.role !== 'measure'"
              allow-clear
            />
          </template>
        </template>
      </Table>
    </Spin>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { ref } from 'vue'

  import { Alert, Input, Select, Spin, Table } from 'ant-design-vue'

  import {
    getMetricModelApi,
    replaceMetricModelColumnsApi,
    type MetricModelColumn,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { AGG_OPTIONS, COLUMN_ROLE_OPTIONS } from '../data'

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const loading = ref(false)
  const submitting = ref(false)
  const modelName = ref('')
  const modelId = ref('')
  const physicalColumns = ref<MetricModelColumn[]>([])

  const readOnlyColumns = [
    { title: '物理列', dataIndex: 'columnName', key: 'columnName', width: 160 },
    { title: '类型', dataIndex: 'dataType', key: 'dataType', width: 120 },
    { title: '业务名', key: 'bizName', width: 160 },
    { title: '角色', key: 'role', width: 120 },
    { title: '默认聚合', key: 'aggDefault', width: 160 },
  ]

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    modelId.value = data?.modelId || ''
    modelName.value = data?.modelName || ''
    physicalColumns.value = []
    if (!modelId.value) return
    loading.value = true
    try {
      const detail = await getMetricModelApi(modelId.value)
      physicalColumns.value = (detail?.columns || []).map((c) => ({ ...c }))
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '字段加载失败'))
    } finally {
      loading.value = false
    }
  })

  async function handleSubmit() {
    const invalid = physicalColumns.value.find((c) => !c.columnName)
    if (invalid) {
      createMessage.error('存在空列名')
      return
    }
    submitting.value = true
    try {
      await replaceMetricModelColumnsApi(modelId.value, physicalColumns.value.map(({ ...rest }) => rest))
      createMessage.success('字段已保存')
      closeModal()
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
    }
  }
</script>
