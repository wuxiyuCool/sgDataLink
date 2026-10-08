<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑模型' : '新建模型'"
    :width="860"
    :min-height="320"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Form ref="formRef" :model="formState" :rules="getRules" layout="vertical">
      <Row :gutter="16">
        <Col :span="12">
          <FormItem label="模型名称" name="name">
            <Input v-model:value="formState.name" placeholder="如 订单明细" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="指标域" name="domainId">
            <TreeSelect
              v-model:value="formState.domainId"
              :tree-data="domainOptions"
              tree-default-expand-all
              placeholder="选择所属域"
              style="width: 100%"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="分层" name="layer">
            <Select v-model:value="formState.layer" :options="LAYER_OPTIONS" />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="创建方式" name="createType">
            <Select
              v-model:value="formState.createType"
              :options="CREATE_TYPE_OPTIONS"
              :disabled="isUpdate"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="数据源" name="datasourceId">
            <Select
              v-model:value="formState.datasourceId"
              :options="dsOptions"
              :disabled="isUpdate"
              placeholder="选择已登记的数据源"
              show-search
              :filter-option="filterOption"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem
            :label="formState.createType === 'ddl' ? '新表名（可留空自动命名）' : '物理表'"
            name="tableName"
          >
            <TableSelect
              v-if="formState.createType === 'reference'"
              v-model:value="formState.tableName"
              :datasource-id="formState.datasourceId"
              placeholder="先选数据源，再选表"
            />
            <Input
              v-else
              v-model:value="formState.tableName"
              placeholder="留空 = 域编码+分层+模型名自动生成"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="时间列" name="timeColumn">
            <Select
              v-model:value="formState.timeColumn"
              :options="timeColumnOptions"
              allow-clear
              :disabled="formState.createType === 'reference' && !isUpdate"
              placeholder="reference 引用表自动识别；ddl 从字段选"
            />
          </FormItem>
        </Col>
        <Col :span="12">
          <FormItem label="状态" name="status">
            <Select
              v-model:value="formState.status"
              :options="[
                { label: '启用', value: 'online' },
                { label: '停用', value: 'offline' },
              ]"
            />
          </FormItem>
        </Col>
        <Col :span="24">
          <FormItem label="备注" name="remark">
            <Textarea v-model:value="formState.remark" :rows="2" />
          </FormItem>
        </Col>
      </Row>

      <template v-if="formState.createType === 'ddl'">
        <Divider orientation="left"
          >字段定义（保存即生成建表 DDL，物理表由清洗汇总任务首次执行时创建）</Divider
        >
        <ColumnsEditor v-model="columnsState" allow-struct />
        <div class="mt-2">
          <Button size="small" :loading="ddlLoading" @click="handlePreviewDdl"
            >生成 DDL 预览</Button
          >
        </div>
        <pre v-if="ddlText" class="ddl-block">{{ ddlText }}</pre>
      </template>
      <Alert
        v-else-if="!isUpdate"
        class="mt-2"
        type="info"
        show-icon
        message="引用模式：保存时自动拉取真实表结构并识别维度/时间/度量角色，之后可在「字段」里维护业务名。"
      />
    </Form>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, reactive, ref } from 'vue'

  import { Alert, Divider, Form, Input, Row, Col, Select, TreeSelect } from 'ant-design-vue'

  import { getDatasourceListApi } from '/@/api/databridge/datasource'
  import {
    createMetricModelApi,
    getMetricDomainTreeApi,
    getMetricModelApi,
    previewModelDdlApi,
    updateMetricModelApi,
    type MetricDomain,
    type MetricModel,
    type MetricModelColumn,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'

  import TableSelect from '../../databridge/components/TableSelect.vue'
  import { LAYER_OPTIONS } from '../data'
  import ColumnsEditor from './ColumnsEditor.vue'

  const FormItem = Form.Item
  const Textarea = Input.TextArea

  const emit = defineEmits(['success', 'register'])
  const { createMessage } = useMessage()

  const isUpdate = ref(false)
  const submitting = ref(false)
  const domainOptions = ref<any[]>([])
  const dsOptions = ref<{ label: string; value: string }[]>([])
  const columnsState = ref<MetricModelColumn[]>([])
  const ddlText = ref('')
  const ddlLoading = ref(false)

  const CREATE_TYPE_OPTIONS = [
    { label: '引用已有表', value: 'reference' },
    { label: '界面建表（DDL）', value: 'ddl' },
  ]

  const formState = reactive({
    id: '',
    name: '',
    domainId: undefined as string | undefined,
    layer: 'DWD',
    createType: 'reference',
    datasourceId: undefined as string | undefined,
    tableName: '',
    timeColumn: undefined as string | undefined,
    status: 'online',
    remark: '',
  })

  const getRules = computed(() => ({
    name: [{ required: true, message: '请输入模型名称' }],
    domainId: [{ required: true, message: '请选择指标域' }],
    datasourceId: [{ required: true, message: '请选择数据源' }],
    tableName:
      formState.createType === 'reference' ? [{ required: true, message: '请选择物理表' }] : [],
  }))

  const timeColumnOptions = computed(() => {
    if (formState.createType === 'ddl') {
      return columnsState.value.map((c) => ({
        label: `${c.columnName}${c.bizName ? `（${c.bizName}）` : ''}`,
        value: c.columnName,
      }))
    }
    // reference：编辑时给出详情列可选（新建时由后端自动识别）
    return detailColumns.value.map((c) => ({
      label: `${c.columnName}${c.bizName ? `（${c.bizName}）` : ''}`,
      value: c.columnName,
    }))
  })

  const detailColumns = ref<MetricModelColumn[]>([])

  function filterOption(input: string, option: any) {
    return String(option?.label || '')
      .toLowerCase()
      .includes(input.toLowerCase())
  }

  function toTreeOptions(nodes: MetricDomain[]): any[] {
    return nodes.map((node) => ({
      value: node.id,
      title: node.name,
      children: node.children?.length ? toTreeOptions(node.children) : undefined,
    }))
  }

  async function ensureOptions() {
    if (!domainOptions.value.length) {
      try {
        const tree = await getMetricDomainTreeApi()
        domainOptions.value = toTreeOptions(tree?.items ?? [])
      } catch {
        domainOptions.value = []
      }
    }
    if (!dsOptions.value.length) {
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
  }

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    setModalProps({ confirmLoading: false })
    ddlText.value = ''
    await ensureOptions()
    isUpdate.value = !!data?.isUpdate
    const record: MetricModel | undefined = data?.record
    if (record) {
      formState.id = record.id
      formState.name = record.name
      formState.domainId = record.domainId
      formState.layer = record.layer
      formState.createType = record.createType
      formState.datasourceId = record.datasourceId
      formState.tableName = record.tableName
      formState.timeColumn = record.timeColumn || undefined
      formState.status = record.status || 'online'
      formState.remark = record.remark || ''
      detailColumns.value = []
      try {
        const detail = await getMetricModelApi(record.id)
        detailColumns.value = detail?.columns || []
        formState.timeColumn = detail?.timeColumn || formState.timeColumn
        formState.remark = detail?.remark ?? formState.remark
      } catch {
        detailColumns.value = record.columns ? [...record.columns] : []
      }
      columnsState.value = detailColumns.value.length
        ? [...detailColumns.value]
        : record.columns
        ? [...record.columns]
        : []
      if (record.createType === 'ddl' && record.tableDdl) ddlText.value = record.tableDdl
    } else {
      formState.id = ''
      formState.name = ''
      formState.domainId = undefined
      formState.layer = 'DWD'
      formState.createType = 'reference'
      formState.datasourceId = undefined
      formState.tableName = ''
      formState.timeColumn = undefined
      formState.status = 'online'
      formState.remark = ''
      columnsState.value = []
    }
  })

  async function handlePreviewDdl() {
    ddlLoading.value = true
    try {
      const result = await previewModelDdlApi({
        domainId: formState.domainId,
        layer: formState.layer,
        name: formState.name,
        tableName: formState.tableName || undefined,
        columns: columnsState.value,
      })
      ddlText.value = result?.ddl || '(无内容)'
      if (result?.conflict)
        createMessage.warning(`表名 ${result.tableName} 与其他模型冲突，保存会被拒绝（40904）`)
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, 'DDL 预览失败（表名冲突 40904 会在此提示）'))
    } finally {
      ddlLoading.value = false
    }
  }

  async function handleSubmit() {
    submitting.value = true
    try {
      const payload: Partial<MetricModel> = {
        name: formState.name.trim(),
        domainId: formState.domainId,
        layer: formState.layer,
        datasourceId: formState.datasourceId,
        tableName: formState.tableName || undefined,
        timeColumn: formState.timeColumn || undefined,
        status: formState.status,
        remark: formState.remark,
      }
      let result: any
      if (isUpdate.value && formState.id) {
        result = await updateMetricModelApi(formState.id, payload)
        createMessage.success('模型已更新')
      } else {
        result = await createMetricModelApi({
          ...payload,
          createType: formState.createType as 'reference' | 'ddl',
          columns: formState.createType === 'ddl' ? columnsState.value : undefined,
        })
        createMessage.success('模型已创建')
        if (result?.warnings?.length) createMessage.warning(result.warnings.join('；'))
      }
      closeModal()
      emit('success')
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
    }
  }
</script>

<style lang="less" scoped>
  .ddl-block {
    margin-top: 8px;
    padding: 8px 12px;
    background: #f6f8fa;
    border-radius: 4px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
