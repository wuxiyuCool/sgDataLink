<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑 Data API' : '新建 Data API'"
    :width="880"
    :min-height="460"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Form
      ref="formRef"
      :model="formState"
      :rules="getRules"
      :label-col="{ span: 5 }"
      :wrapper-col="{ span: 18 }"
    >
      <Divider orientation="left" plain class="!mt-0 !mb-3">基本信息</Divider>
      <FormItem label="服务名称" name="name">
        <Input v-model:value="formState.name" placeholder="例如：订单查询服务" />
      </FormItem>
      <FormItem
        label="路径 path"
        name="path"
        extra="对外地址为 GET /ds/{path}，仅允许小写字母、数字与连字符"
      >
        <Input v-model:value="formState.path" placeholder="例如：order-query">
          <template #suffix>
            <Button type="link" size="small" @click="handleSuggestPath">按名称生成</Button>
          </template>
        </Input>
      </FormItem>
      <FormItem label="请求方法" name="method">
        <Select v-model:value="formState.method" :options="DATAAPI_METHOD_OPTIONS" />
      </FormItem>
      <FormItem label="数据源" name="datasourceId">
        <Select
          v-model:value="formState.datasourceId"
          :options="datasourceOptions"
          :loading="datasourceLoading"
          show-search
          option-filter-prop="label"
          placeholder="请选择提供数据的数据源"
        />
      </FormItem>
      <FormItem label="数据表" name="tableName">
        <Input v-model:value="formState.tableName" placeholder="例如：T_ORDER_MIRROR" />
      </FormItem>

      <Divider orientation="left" plain class="!mt-0 !mb-3">输出字段</Divider>
      <FormItem :wrapper-col="{ span: 24 }">
        <Table
          :columns="fieldTableColumns"
          :data-source="formState.fields"
          :pagination="false"
          row-key="__key"
          size="small"
          :bordered="true"
          :scroll="{ y: 220 }"
        >
          <template #bodyCell="{ column, index, record }">
            <template v-if="column.key === 'name'">
              <Input
                v-model:value="record.name"
                size="small"
                placeholder="如 ID"
              />
            </template>
            <template v-else-if="column.key === 'type'">
              <Select
                v-model:value="record.type"
                size="small"
                style="width: 140px"
                :options="DATAAPI_FIELD_TYPE_OPTIONS"
              />
            </template>
            <template v-else-if="column.key === 'action'">
              <Button type="link" size="small" danger @click="handleRemoveField(index)">删除</Button>
            </template>
          </template>
        </Table>
        <Button size="small" class="mt-2" @click="handleAddField">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新增字段
        </Button>
      </FormItem>

      <Divider orientation="left" plain class="!mt-0 !mb-3">查询参数</Divider>
      <FormItem :wrapper-col="{ span: 24 }">
        <Table
          :columns="queryParamTableColumns"
          :data-source="formState.queryParams"
          :pagination="false"
          row-key="__key"
          size="small"
          :bordered="true"
        >
          <template #bodyCell="{ column, index, record }">
            <template v-if="column.key === 'name'">
              <Input
                v-model:value="record.name"
                size="small"
                placeholder="如 minAmount"
              />
            </template>
            <template v-else-if="column.key === 'type'">
              <Select
                v-model:value="record.type"
                size="small"
                style="width: 120px"
                :options="DATAAPI_QUERY_TYPE_OPTIONS"
              />
            </template>
            <template v-else-if="column.key === 'required'">
              <Checkbox
                :checked="!!record.required"
                @change="record.required = $event.target.checked"
              />
            </template>
            <template v-else-if="column.key === 'action'">
              <Button type="link" size="small" danger @click="handleRemoveParam(index)">
                删除
              </Button>
            </template>
          </template>
        </Table>
        <Button size="small" class="mt-2" @click="handleAddParam">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新增查询参数
        </Button>
      </FormItem>

      <Divider orientation="left" plain class="!mt-0 !mb-3">鉴权与限流</Divider>
      <FormItem
        label="启用鉴权"
        name="authEnabled"
        extra="关闭后运行时不校验 X-API-Key（契约 1.9：401/40101 只在开启时返回）"
      >
        <Switch v-model:checked="formState.authEnabled" />
      </FormItem>
      <FormItem label="限流 QPS" name="rateLimitQps" extra="后端按滑动窗口真实拦截，超限返回 429/42901">
        <InputNumber
          v-model:value="formState.rateLimitQps"
          :min="1"
          :max="10000"
          :precision="0"
          style="width: 100%"
        />
      </FormItem>
      <FormItem
        label="IP 白名单"
        name="ipWhitelistText"
        extra="每行一个 IP 或前缀通配（如 10.0.0.*），留空表示不限制；后端只做精确匹配 + * 前缀比对，不支持 CIDR 网段写法"
      >
        <TextArea v-model:value="formState.ipWhitelistText" :rows="3" placeholder="192.168.1.10&#10;10.0.0.*" />
      </FormItem>
    </Form>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref } from 'vue'
  import {
    Button,
    Checkbox,
    Divider,
    Form,
    Input,
    InputNumber,
    Select,
    Switch,
    Table,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import { createDataApiItemApi, updateDataApiItemApi } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    DataApi,
    DataApiFieldType,
    DataApiMethod,
    DataApiPayload,
    DataApiQueryParam,
  } from '/@/api/databridge/model/dataapiModel'
  import type { SelectOption } from '../data'
  import {
    DATAAPI_FIELD_TYPE_OPTIONS,
    DATAAPI_METHOD_OPTIONS,
    DATAAPI_QUERY_TYPE_OPTIONS,
    DEFAULT_DATAAPI_RATE_LIMIT_QPS,
    pickDataApiPayload,
  } from '../data'
  import {
    DATAAPI_PATH_PATTERN,
    fieldTableColumns,
    queryParamTableColumns,
    suggestApiPath,
  } from './dataapi.data'

  const FormItem = Form.Item
  const TextArea = Input.TextArea

  /** 行编辑用的字段/参数在原结构上多一个表格 rowKey */
  type DataApiFieldItem = DataApiPayload['fields'][number]
  interface FieldRow extends DataApiFieldItem {
    __key: string
  }
  interface ParamRow extends DataApiQueryParam {
    __key: string
  }

  const emit = defineEmits(['register', 'success'])
  const { createMessage } = useMessage()

  const formRef = ref()
  const isUpdate = ref(false)
  const submitting = ref(false)
  const datasourceLoading = ref(false)
  const datasourceOptions = ref<SelectOption[]>([])
  let rowSeed = 0

  const defaultForm = () => ({
    id: undefined as string | undefined,
    name: '',
    path: '',
    method: 'GET' as DataApiMethod,
    datasourceId: undefined as string | undefined,
    tableName: '',
    fields: [] as FieldRow[],
    queryParams: [] as ParamRow[],
    authEnabled: true,
    rateLimitQps: DEFAULT_DATAAPI_RATE_LIMIT_QPS as number,
    ipWhitelistText: '',
  })

  const formState = reactive<ReturnType<typeof defaultForm>>(defaultForm())

  const getRules = computed<Record<string, any>>(() => ({
    name: [{ required: true, message: '请输入服务名称', trigger: 'blur' }],
    path: [
      { required: true, message: '请输入对外路径 path', trigger: 'blur' },
      {
        validator: (_rule: any, value: string) =>
          !value || DATAAPI_PATH_PATTERN.test(value)
            ? Promise.resolve()
            : Promise.reject(new Error('path 只能包含小写字母、数字与连字符，且以字母或数字开头')),
        trigger: 'blur',
      },
    ],
    method: [{ required: true, message: '请选择请求方法', trigger: 'change' }],
    datasourceId: [{ required: true, message: '请选择数据源', trigger: 'change' }],
    tableName: [{ required: true, message: '请输入数据表名', trigger: 'blur' }],
    rateLimitQps: [
      { required: true, type: 'number', message: '请输入限流 QPS', trigger: 'change' },
    ],
  }))

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    isUpdate.value = !!data?.isUpdate
    submitting.value = false
    Object.assign(formState, defaultForm())
    setModalProps({ confirmLoading: false })
    formRef.value?.clearValidate?.()

    if (data?.record) {
      const record: DataApi = data.record
      Object.assign(formState, {
        id: record.id,
        name: record.name,
        path: record.path,
        method: (record.method || 'GET') as DataApiMethod,
        datasourceId: record.datasourceId,
        tableName: record.tableName,
        fields: (record.fields ?? []).map((item) => toFieldRow(item)),
        queryParams: (record.queryParams ?? []).map((item) => toParamRow(item)),
        authEnabled: record.authEnabled !== false,
        rateLimitQps: record.rateLimitQps ?? DEFAULT_DATAAPI_RATE_LIMIT_QPS,
        ipWhitelistText: (record.ipWhitelist ?? []).join('\n'),
      })
    }
    loadDatasources()
  })

  function nextKey() {
    rowSeed += 1
    return `row-${rowSeed}`
  }

  function toFieldRow(item: { name: string; type: DataApiFieldType }): FieldRow {
    return { ...item, __key: nextKey() }
  }

  function toParamRow(item: DataApiQueryParam): ParamRow {
    return { ...item, __key: nextKey() }
  }

  async function loadDatasources() {
    datasourceLoading.value = true
    try {
      const list = await getAllDatasourcesApi()
      datasourceOptions.value = list.map((item) => ({
        label: `${item.name}（${item.type} · ${item.host}:${item.port}）`,
        value: item.id as string,
      }))
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '数据源列表加载失败'))
    } finally {
      datasourceLoading.value = false
    }
  }

  function handleSuggestPath() {
    formState.path = suggestApiPath(formState.path || formState.name)
  }

  function handleAddField() {
    formState.fields = [
      ...formState.fields,
      toFieldRow({ name: '', type: 'VARCHAR' as DataApiFieldType }),
    ]
  }

  function handleRemoveField(index: number) {
    formState.fields = formState.fields.filter((_item, i) => i !== index)
  }

  function handleAddParam() {
    formState.queryParams = [...formState.queryParams, toParamRow({ name: '', type: 'string' })]
  }

  function handleRemoveParam(index: number) {
    formState.queryParams = formState.queryParams.filter((_item, i) => i !== index)
  }

  function parseIpWhitelist(text: string): string[] {
    return Array.from(
      new Set(
        String(text ?? '')
          .split(/[\n,，;；]/)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    )
  }

  /** 行编辑内容的本地自检，避免把空行写进后端 */
  function validateRows(): string {
    const fields = formState.fields ?? []
    if (!fields.length) return '请至少配置一个输出字段'
    if (fields.some((item) => !String(item.name).trim())) return '存在未填写字段名的输出字段行'
    const duplicatedField = fields.find(
      (item, index) => fields.findIndex((other) => other.name === item.name) !== index,
    )
    if (duplicatedField) return `输出字段重复：${duplicatedField.name}`
    const params = formState.queryParams ?? []
    if (params.some((item) => !String(item.name).trim())) return '存在未填写参数名的查询参数行'
    const duplicatedParam = params.find(
      (item, index) => params.findIndex((other) => other.name === item.name) !== index,
    )
    if (duplicatedParam) return `查询参数重复：${duplicatedParam.name}`
    return ''
  }

  function buildPayload(): DataApiPayload {
    return pickDataApiPayload({
      name: formState.name,
      path: formState.path,
      method: formState.method,
      datasourceId: String(formState.datasourceId ?? ''),
      tableName: formState.tableName,
      fields: formState.fields.map((item) => ({ name: item.name, type: item.type })),
      queryParams: formState.queryParams.map((item) => ({
        name: item.name,
        type: item.type,
        required: !!item.required,
      })),
      authEnabled: !!formState.authEnabled,
      rateLimitQps: Number(formState.rateLimitQps ?? DEFAULT_DATAAPI_RATE_LIMIT_QPS),
      ipWhitelist: parseIpWhitelist(formState.ipWhitelistText),
    })
  }

  async function handleSubmit() {
    if (formRef.value) {
      try {
        await formRef.value.validate()
      } catch {
        return
      }
    }
    const rowError = validateRows()
    if (rowError) {
      createMessage.warning(rowError)
      return
    }
    submitting.value = true
    setModalProps({ confirmLoading: true })
    try {
      const payload = buildPayload()
      const id = formState.id
      if (unref(isUpdate) && id) {
        await updateDataApiItemApi(id, payload)
        createMessage.success('数据服务已更新')
      } else {
        await createDataApiItemApi(payload)
        createMessage.success('数据服务已创建（草稿状态，发布后才可访问）')
      }
      closeModal()
      emit('success')
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
      setModalProps({ confirmLoading: false })
    }
  }
</script>
