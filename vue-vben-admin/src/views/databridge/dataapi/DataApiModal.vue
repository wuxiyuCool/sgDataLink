<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑 Data API' : '新建 Data API'"
    :width="920"
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

      <Divider orientation="left" plain class="!mt-0 !mb-3">数据来源</Divider>
      <FormItem
        label="SQL 模式"
        name="sqlMode"
        extra="构建模式按表 + 勾选字段自动拼 SELECT；自定义 SQL 由后端执行你编写的只读语句（契约 1.9.2）"
      >
        <RadioGroup
          v-model:value="formState.sqlMode"
          :options="DATAAPI_SQL_MODE_OPTIONS"
          option-type="button"
          @change="handleSqlModeChange"
        />
      </FormItem>
      <FormItem label="数据源" name="datasourceId">
        <Select
          v-model:value="formState.datasourceId"
          :options="datasourceOptions"
          :loading="datasourceLoading"
          show-search
          option-filter-prop="label"
          placeholder="请选择提供数据的数据源"
          @change="handleDatasourceChange"
        />
      </FormItem>

      <!-- builder：表名下拉（meta/tables 远程加载）+ 字段勾选（meta/columns） -->
      <template v-if="isBuilder">
        <FormItem
          label="数据表"
          name="tableName"
          extra="选定数据源后远程加载可查表，支持关键字搜索（防抖 300ms）；换表会清空已勾选字段"
        >
          <Select
            v-model:value="formState.tableName"
            :options="tableOptions"
            :loading="tablesLoading"
            :disabled="!formState.datasourceId"
            show-search
            :filter-option="false"
            allow-clear
            placeholder="点击加载表列表，可直接输入关键字搜索"
            @search="handleTableSearch"
            @change="handleTableSelectChange"
            @dropdown-visible-change="handleTableDropdownOpen"
          />
        </FormItem>

        <FormItem v-if="showColumnPicker" label="输出字段" :wrapper-col="{ span: 18 }">
          <div class="mb-1 text-gray-500">
            共 {{ metaColumns.length }} 列，已勾选 {{ selectedFieldNames.length }} 列；
            字段类型由元数据自动带出
          </div>
          <Table
            :columns="metaColumnTableColumns"
            :data-source="metaColumns"
            :row-selection="columnRowSelection"
            :loading="columnsLoading"
            :pagination="false"
            row-key="name"
            size="small"
            :bordered="true"
            :scroll="{ y: 220 }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'nullable'">
                <Tag v-if="record.nullable === false" color="red">否</Tag>
                <Tag v-else-if="record.nullable === true" color="green">是</Tag>
                <span v-else>-</span>
              </template>
              <template v-else-if="column.key === 'comment'">
                {{ record.comment || '-' }}
              </template>
            </template>
          </Table>
        </FormItem>
        <FormItem v-else label="输出字段" :wrapper-col="{ span: 24 }">
          <div class="mb-1 text-gray-500">
            未加载到表字段元数据（请先选择数据源与数据表，或后端 meta 接口不可用时手动维护）
          </div>
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
                  :options="fieldTypeOptions"
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
      </template>

      <template v-else>
        <!-- custom：等宽 textarea + 帮助文案 + 占位符差集提示 -->
        <FormItem label="自定义 SQL" name="customSql" :wrapper-col="{ span: 19 }">
          <TextArea
            v-model:value="formState.customSql"
            :rows="8"
            class="sql-editor"
            placeholder="SELECT sid, ms_bill_id, amount FROM ir_cm_measure WHERE status = :status AND org_id IN (:orgIds)"
          />
          <Alert
            v-if="sqlCheckError"
            class="mt-2"
            type="error"
            show-icon
            :message="sqlCheckError"
            description="前端只读预检仅作第一道防线，保存时后端仍会按契约 1.9.2 权威校验"
          />
          <Alert type="info" show-icon class="mt-2">
            <template #message>占位符与绑定规则</template>
            <template #description>
              <ul class="sql-help m-0 pl-4">
                <li>
                  SQL 内用 <code>:name</code> 占位查询参数，如 <code>WHERE status = :status</code>，
                  参数名与下方「查询参数」一一对应，后端一律绑定变量注入、绝不拼接
                </li>
                <li>
                  list 参数写 <code>IN (:codes)</code>，调用时传逗号分隔值（如
                  <code>codes=A,B,C</code>），后端逐元素展开绑定，上限 1000 个
                </li>
                <li>
                  时间条件建议显式 <code>TO_DATE(:t,'YYYY-MM-DD HH24:MI:SS')</code>，
                  值按字符串绑定，避免时区歧义
                </li>
                <li>仅允许只读语句：SELECT / WITH 开头、禁止多语句与写操作关键字</li>
              </ul>
            </template>
          </Alert>
          <div class="mt-2">
            <div v-if="sqlParamDiff.missing.length" class="param-diff-line">
              <span class="mr-1">SQL 中引用但未声明：</span>
              <Tag v-for="name in sqlParamDiff.missing" :key="`miss-${name}`" color="red">
                {{ name }}
              </Tag>
            </div>
            <div v-if="sqlParamDiff.unused.length" class="param-diff-line">
              <span class="mr-1">已声明但 SQL 未引用（不阻止提交）：</span>
              <Tag v-for="name in sqlParamDiff.unused" :key="`unus-${name}`" color="orange">
                {{ name }}
              </Tag>
            </div>
            <div v-if="!sqlPlaceholders.length" class="text-gray-500">
              当前 SQL 未检测到 :占位符，可不调用查询参数
            </div>
            <div v-else class="text-gray-500">
              SQL 解析到 {{ sqlPlaceholders.length }} 个占位符：{{ sqlPlaceholders.join('、') }}
            </div>
          </div>
        </FormItem>
      </template>

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
                :placeholder="record.type === 'list' ? '如 codes（调用时传逗号分隔）' : '如 minAmount'"
              />
            </template>
            <template v-else-if="column.key === 'type'">
              <Select
                v-model:value="record.type"
                size="small"
                style="width: 170px"
                :options="DATAAPI_QUERY_PARAM_TYPE_OPTIONS"
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
    Alert,
    Button,
    Checkbox,
    Divider,
    Form,
    Input,
    InputNumber,
    Radio,
    Select,
    Switch,
    Table,
    Tag,
  } from 'ant-design-vue'
  import { useDebounceFn } from '@vueuse/core'
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import {
    createDataApiItemApi,
    getMetaColumnsApi,
    getMetaTablesApi,
    updateDataApiItemApi,
  } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    DataApi,
    DataApiFieldType,
    DataApiMethod,
    DataApiQueryParam,
    DataApiSqlMode,
  } from '/@/api/databridge/model/dataapiModel'
  import type { MetaColumn } from '/@/api/databridge/model/dataapiModel'
  import type { DataApiPayload } from '/@/api/databridge/model/dataapiModel'
  import type { SelectOption } from '../data'
  import {
    DATAAPI_FIELD_TYPE_OPTIONS,
    DATAAPI_METHOD_OPTIONS,
    DEFAULT_DATAAPI_RATE_LIMIT_QPS,
    pickDataApiPayload,
  } from '../data'
  import {
    DATAAPI_PATH_PATTERN,
    DATAAPI_QUERY_PARAM_TYPE_OPTIONS,
    DATAAPI_SQL_MODE_OPTIONS,
    checkCustomSql,
    diffSqlPlaceholders,
    extractSqlPlaceholders,
    fieldTableColumns,
    metaColumnTableColumns,
    queryParamTableColumns,
    suggestApiPath,
  } from './dataapi.data'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const RadioGroup = Radio.Group

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

  /** meta/tables 远程下拉状态（契约 1.9.1） */
  const tableOptions = ref<SelectOption[]>([])
  const tablesLoading = ref(false)
  /** meta/columns 字段勾选状态 */
  const metaColumns = ref<MetaColumn[]>([])
  const columnsLoading = ref(false)
  const selectedFieldNames = ref<string[]>([])

  const defaultForm = () => ({
    id: undefined as string | undefined,
    name: '',
    path: '',
    method: 'GET' as DataApiMethod,
    sqlMode: 'builder' as DataApiSqlMode,
    datasourceId: undefined as string | undefined,
    tableName: '' as string | undefined,
    customSql: '',
    fields: [] as FieldRow[],
    queryParams: [] as ParamRow[],
    authEnabled: true,
    rateLimitQps: DEFAULT_DATAAPI_RATE_LIMIT_QPS as number,
    ipWhitelistText: '',
  })

  const formState = reactive<ReturnType<typeof defaultForm>>(defaultForm())

  const isBuilder = computed(() => formState.sqlMode !== 'custom')
  /** builder 模式且已加载到字段元数据时，用勾选表格替代手动字段表 */
  const showColumnPicker = computed(() => isBuilder.value && metaColumns.value.length > 0)

  /** 手动字段表里把已带出的数据库类型也加入下拉选项，避免回显空白 */
  const fieldTypeOptions = computed<SelectOption[]>(() => {
    const known = new Set(DATAAPI_FIELD_TYPE_OPTIONS.map((item) => String(item.value)))
    const extras = formState.fields
      .map((item) => String(item.type ?? ''))
      .filter((item) => item && !known.has(item))
      .map((item) => ({ label: item, value: item }))
    return [...DATAAPI_FIELD_TYPE_OPTIONS, ...extras] as SelectOption[]
  })

  /** custom 模式实时解析 :占位符 与已声明参数的差集（契约 1.9.2：占位符集合 ⊆ queryParams） */
  const sqlPlaceholders = computed(() => extractSqlPlaceholders(formState.customSql))
  const declaredParamNames = computed(() =>
    (formState.queryParams ?? []).map((item) => String(item.name ?? '').trim()).filter(Boolean),
  )
  const sqlParamDiff = computed(() =>
    diffSqlPlaceholders(sqlPlaceholders.value, declaredParamNames.value),
  )
  /** 只读预检结果（空串 = 通过），红字实时展示，提交时同样拦截 */
  const sqlCheckError = computed(() =>
    isBuilder.value ? '' : checkCustomSql(formState.customSql),
  )

  const columnRowSelection = computed(() => ({
    selectedRowKeys: selectedFieldNames.value,
    columnWidth: 46,
    onChange: handleColumnSelectChange,
  }))

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
    tableName: isBuilder.value
      ? [{ required: true, message: '请选择数据表', trigger: 'change' }]
      : [],
    customSql: isBuilder.value
      ? []
      : [
          {
            validator: (_rule: any, value: string) => {
              const error = checkCustomSql(value)
              return error ? Promise.reject(new Error(error)) : Promise.resolve()
            },
            trigger: ['blur', 'change'],
          },
        ],
    rateLimitQps: [
      { required: true, type: 'number', message: '请输入限流 QPS', trigger: 'change' },
    ],
  }))

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    isUpdate.value = !!data?.isUpdate
    submitting.value = false
    Object.assign(formState, defaultForm())
    tableOptions.value = []
    metaColumns.value = []
    selectedFieldNames.value = []
    setModalProps({ confirmLoading: false })
    formRef.value?.clearValidate?.()

    if (data?.record) {
      const record: DataApi = data.record
      Object.assign(formState, {
        id: record.id,
        name: record.name,
        path: record.path,
        method: (record.method || 'GET') as DataApiMethod,
        sqlMode: record.sqlMode === 'custom' ? ('custom' as DataApiSqlMode) : ('builder' as DataApiSqlMode),
        datasourceId: record.datasourceId,
        tableName: record.tableName,
        customSql: record.customSql ?? '',
        fields: (record.fields ?? []).map((item) => toFieldRow(item)),
        queryParams: (record.queryParams ?? []).map((item) => toParamRow(item)),
        authEnabled: record.authEnabled !== false,
        rateLimitQps: record.rateLimitQps ?? DEFAULT_DATAAPI_RATE_LIMIT_QPS,
        ipWhitelistText: (record.ipWhitelist ?? []).join('\n'),
      })
    }
    loadDatasources()
    // 编辑回显：builder 模式下预载表列表与字段，并把已保存字段勾选回去
    if (
      data?.record &&
      formState.sqlMode === 'builder' &&
      formState.datasourceId &&
      formState.tableName
    ) {
      loadTables('')
      const savedNames = formState.fields.map((item) => String(item.name))
      loadColumns(String(formState.tableName)).then(() => {
        const present = new Set(metaColumns.value.map((item) => item.name))
        selectedFieldNames.value = savedNames.filter((name) => present.has(name))
      })
    }
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

  /** 表名远程搜索：keyword 走后端 LIKE（契约 1.9.1），onSearch 防抖 300ms */
  async function loadTables(keyword?: string) {
    const datasourceId = String(formState.datasourceId ?? '')
    if (!datasourceId) {
      tableOptions.value = []
      return
    }
    tablesLoading.value = true
    try {
      const list = await getMetaTablesApi({
        datasourceId,
        keyword: String(keyword ?? '').trim() || undefined,
      })
      const options = (list ?? []).map((item) => ({
        label: item.comment ? `${item.name}（${item.comment}）` : item.name,
        value: item.name,
      }))
      keepCurrentTableOption(options)
      tableOptions.value = options
    } catch (error: any) {
      const fallback: SelectOption[] = []
      keepCurrentTableOption(fallback)
      tableOptions.value = fallback
      createMessage.warning(getApiErrorMessage(error, '表列表加载失败，可退回手动配置'))
    } finally {
      tablesLoading.value = false
    }
  }

  /** 搜索结果不含当前选中表（编辑回显/按关键字过滤）时补一项，避免下拉丢值 */
  function keepCurrentTableOption(options: SelectOption[]) {
    const current = String(formState.tableName ?? '')
    if (current && !options.some((item) => item.value === current)) {
      options.unshift({ label: current, value: current })
    }
  }

  const handleTableSearch = useDebounceFn((keyword: string) => loadTables(keyword), 300)

  function handleTableDropdownOpen(open: boolean) {
    if (open && !tableOptions.value.length && formState.datasourceId) loadTables('')
  }

  async function loadColumns(tableName: string) {
    metaColumns.value = []
    const datasourceId = String(formState.datasourceId ?? '')
    if (!datasourceId || !tableName) return
    columnsLoading.value = true
    try {
      const list = await getMetaColumnsApi({ datasourceId, tableName })
      metaColumns.value = (list ?? []).map((item) => ({ ...item }))
    } catch (error: any) {
      metaColumns.value = []
      createMessage.warning(getApiErrorMessage(error, '字段列表加载失败，可退回手动配置输出字段'))
    } finally {
      columnsLoading.value = false
    }
  }

  /** 换数据源：表/列/勾选全部重置（custom 模式仅影响 SQL 执行所在库，不重置 textarea） */
  function handleDatasourceChange() {
    formState.tableName = ''
    tableOptions.value = []
    metaColumns.value = []
    selectedFieldNames.value = []
    formState.fields = []
    loadTables('')
  }

  /** 换表（用户操作）：清空已勾字段并重新拉列 */
  function handleTableSelectChange(value: any) {
    formState.tableName = String(value ?? '')
    selectedFieldNames.value = []
    formState.fields = []
    loadColumns(formState.tableName)
  }

  /** 勾中即进 fields，type 由元数据自动带出 */
  function handleColumnSelectChange(keys: (string | number)[]) {
    const names = (keys ?? []).map(String)
    selectedFieldNames.value = names
    const typeMap = new Map(metaColumns.value.map((item) => [item.name, item.type]))
    formState.fields = names.map((name) =>
      toFieldRow({ name, type: (typeMap.get(name) ?? 'VARCHAR') as DataApiFieldType }),
    )
  }

  function handleSqlModeChange() {
    // 切换模式后清掉另一模式字段的残留校验红字
    formRef.value?.clearValidate?.(['tableName', 'customSql'])
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
    if (isBuilder.value) {
      const fields = formState.fields ?? []
      if (!fields.length) return '请至少配置一个输出字段'
      if (fields.some((item) => !String(item.name).trim())) return '存在未填写字段名的输出字段行'
      const duplicatedField = fields.find(
        (item, index) => fields.findIndex((other) => other.name === item.name) !== index,
      )
      if (duplicatedField) return `输出字段重复：${duplicatedField.name}`
    } else {
      const sqlError = checkCustomSql(formState.customSql)
      if (sqlError) return sqlError
      if (sqlParamDiff.value.missing.length) {
        return `SQL 中引用但未声明的查询参数：${sqlParamDiff.value.missing.join('、')}`
      }
    }
    const params = formState.queryParams ?? []
    if (params.some((item) => !String(item.name).trim())) return '存在未填写参数名的查询参数行'
    const duplicatedParam = params.find(
      (item, index) => params.findIndex((other) => other.name === item.name) !== index,
    )
    if (duplicatedParam) return `查询参数重复：${duplicatedParam.name}`
    return ''
  }

  function buildPayload(): DataApiPayload {
    // pickDataApiPayload（契约 1.9 白名单裁剪）在 data.ts 中未含 1.9.2 新字段，这里补齐；
    // builder 模式省略 customSql 键，避免把另一模式的残留写进后端
    const payload: DataApiPayload = pickDataApiPayload({
      name: formState.name,
      path: formState.path,
      method: formState.method,
      datasourceId: String(formState.datasourceId ?? ''),
      tableName: String(formState.tableName ?? ''),
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
    payload.sqlMode = formState.sqlMode
    if (!isBuilder.value) payload.customSql = String(formState.customSql ?? '').trim()
    return payload
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
<style lang="less" scoped>
  .sql-editor {
    font-family: 'Courier New', Consolas, monospace;
    font-size: 12px;
  }

  .sql-help li {
    line-height: 1.7;
  }

  .param-diff-line {
    margin-bottom: 4px;
  }

  .param-diff-line :deep(.ant-tag) {
    margin-inline-end: 4px;
  }
</style>
