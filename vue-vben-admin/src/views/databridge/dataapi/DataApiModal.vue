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
        extra="构建模式按表 + 勾选字段自动拼 SELECT；自定义 SQL 由后端执行只读语句（契约 1.9.2）；API 转发把请求转调目标系统并透传响应（契约 1.9.3）"
      >
        <RadioGroup
          v-model:value="formState.sqlMode"
          :options="DATAAPI_SQL_MODE_OPTIONS"
          option-type="button"
          @change="handleSqlModeChange"
        />
      </FormItem>
      <FormItem v-if="!isForward" label="数据源" name="datasourceId">
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
          extra="选定数据源后一次性拉取表清单，输入关键字本地过滤；换表会清空已勾选字段"
        >
          <TableSelect
            v-model:value="formState.tableName"
            :datasource-id="formState.datasourceId"
            @change="handleTableSelectChange"
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

      <template v-else-if="isForward">
        <!-- forward：API 转发配置（契约 1.9.3），鉴权/限流照常，响应原样透传 -->
        <FormItem
          label="转发目标"
          name="forwardUrl"
          extra="http/https 完整地址；路径里可用 :name 引用下方查询参数（值自动 URL 编码）；禁止云元址/链路本地地址"
        >
          <Input
            v-model:value="formState.forwardUrl"
            placeholder="http://10.45.x.x:8080/external/bill/:billNr"
          />
        </FormItem>
        <FormItem label="转发方法" name="forwardMethod">
          <RadioGroup
            v-model:value="formState.forwardMethod"
            :options="[
              { label: 'GET', value: 'GET' },
              { label: 'POST（发送体模板）', value: 'POST' },
            ]"
            option-type="button"
          />
        </FormItem>
        <FormItem
          v-if="formState.forwardMethod === 'POST'"
          label="请求体模板"
          name="forwardBodyTemplate"
          :wrapper-col="{ span: 19 }"
          extra=":name 替换后若能 JSON 解析按 application/json 发送，否则 text/plain 原样发送"
        >
          <TextArea
            v-model:value="formState.forwardBodyTemplate"
            :rows="5"
            placeholder='{"billNr": ":billNr", "from": "databridge"}'
          />
        </FormItem>
        <FormItem label="固定请求头" :wrapper-col="{ span: 24 }">
          <div class="mb-1 text-gray-500">
            仅这些头会发给下游（值支持 :name 占位符）；调用方自带 header 一律不下传，防
            X-API-Key / Cookie 泄漏；Authorization 等敏感值不落日志
          </div>
          <Table
            :columns="forwardHeaderColumns"
            :data-source="formState.forwardHeaders"
            :pagination="false"
            row-key="__key"
            size="small"
            :bordered="true"
          >
            <template #bodyCell="{ column, index, record }">
              <template v-if="column.key === 'name'">
                <Input v-model:value="record.name" size="small" placeholder="如 Authorization" />
              </template>
              <template v-else-if="column.key === 'value'">
                <Input
                  v-model:value="record.value"
                  size="small"
                  placeholder="如 Bearer :token（token 需在下方查询参数声明）"
                />
              </template>
              <template v-else-if="column.key === 'action'">
                <Button type="link" size="small" danger @click="handleRemoveForwardHeader(index)">
                  删除
                </Button>
              </template>
            </template>
          </Table>
          <Button size="small" class="mt-2" @click="handleAddForwardHeader">
            <Icon icon="ant-design:plus-outlined" class="mr-1" />
            新增请求头
          </Button>
        </FormItem>
        <FormItem label="超时(ms)" name="forwardTimeoutMs" extra="取值 100~60000；超时/不可达返回 502/50003">
          <InputNumber
            v-model:value="formState.forwardTimeoutMs"
            :min="100"
            :max="60000"
            :precision="0"
            style="width: 100%"
          />
        </FormItem>
        <FormItem
          label="query 透传"
          name="forwardPassthroughQuery"
          extra="把调用方 query 合并进目标 URL（apiKey 除外；同名以转发配置为准）"
        >
          <Switch v-model:checked="formState.forwardPassthroughQuery" />
        </FormItem>
        <Alert
          type="info"
          show-icon
          class="mt-1"
          message="转发模式不查数据库：鉴权 / IP 白名单 / 限流 / 调用统计照常生效，下游状态码与响应体原样透传给调用方（契约 1.9.3）"
        />
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
  import { Icon } from '/@/components/Icon'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import {
    createDataApiItemApi,
    getMetaColumnsApi,
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
  import TableSelect from '../components/TableSelect.vue'

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
    /** 1.9.3 API 转发（契约 1.9.3） */
    forwardUrl: '',
    forwardMethod: 'GET' as 'GET' | 'POST',
    forwardHeaders: [] as ForwardHeaderRow[],
    forwardBodyTemplate: '',
    forwardTimeoutMs: 10000,
    forwardPassthroughQuery: true,
    fields: [] as FieldRow[],
    queryParams: [] as ParamRow[],
    authEnabled: true,
    rateLimitQps: DEFAULT_DATAAPI_RATE_LIMIT_QPS as number,
    ipWhitelistText: '',
  })

  const formState = reactive<ReturnType<typeof defaultForm>>(defaultForm())

  const isBuilder = computed(() => formState.sqlMode === 'builder')
  const isForward = computed(() => formState.sqlMode === 'forward')
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
    isBuilder.value || isForward.value ? '' : checkCustomSql(formState.customSql),
  )

  /** 1.9.3 转发固定请求头行（__key 供 Table row-key 使用） */
  interface ForwardHeaderRow {
    __key: string
    name: string
    value: string
  }
  const forwardHeaderColumns = [
    { title: 'Header 名', key: 'name', dataIndex: 'name', width: 200 },
    { title: '值（支持 :name 占位符）', key: 'value', dataIndex: 'value' },
    { title: '操作', key: 'action', width: 70 },
  ]
  function toForwardHeaderRow(item: { name: string; value: string }): ForwardHeaderRow {
    return { name: String(item.name ?? ''), value: String(item.value ?? ''), __key: nextKey() }
  }
  function handleAddForwardHeader() {
    formState.forwardHeaders = [...formState.forwardHeaders, toForwardHeaderRow({ name: '', value: '' })]
  }
  function handleRemoveForwardHeader(index: number) {
    formState.forwardHeaders = formState.forwardHeaders.filter((_, i) => i !== index)
  }
  /** 契约 1.9.3 保存期红线的前端预检（后端权威校验） */
  function checkForwardUrl(value?: string): string {
    const text = String(value ?? '').trim()
    if (!text) return '请填写转发目标地址 forwardUrl'
    try {
      const url = new URL(text)
      if (!['http:', 'https:'].includes(url.protocol)) return 'forwardUrl 仅支持 http/https 协议'
      if (!url.hostname) return 'forwardUrl host 不能为空'
      if (/^169\.254\./.test(url.hostname) || url.hostname.startsWith('fe80')) {
        return 'forwardUrl 不允许指向链路本地/云元址（SSRF 红线）'
      }
    } catch {
      return 'forwardUrl 不是合法绝对地址'
    }
    return ''
  }

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
    datasourceId: isForward.value
      ? []
      : [{ required: true, message: '请选择数据源', trigger: 'change' }],
    tableName: isBuilder.value
      ? [{ required: true, message: '请选择数据表', trigger: 'change' }]
      : [],
    forwardUrl: isForward.value
      ? [
          {
            validator: (_rule: any, value: string) => {
              const error = checkForwardUrl(value)
              return error ? Promise.reject(new Error(error)) : Promise.resolve()
            },
            trigger: ['blur', 'change'],
          },
        ]
      : [],
    customSql: isBuilder.value || isForward.value
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
        sqlMode:
          record.sqlMode === 'custom'
            ? ('custom' as DataApiSqlMode)
            : record.sqlMode === 'forward'
              ? ('forward' as DataApiSqlMode)
              : ('builder' as DataApiSqlMode),
        datasourceId: record.datasourceId,
        tableName: record.tableName,
        customSql: record.customSql ?? '',
        forwardUrl: record.forwardUrl ?? '',
        forwardMethod: record.forwardMethod === 'POST' ? ('POST' as const) : ('GET' as const),
        forwardHeaders: (record.forwardHeaders ?? []).map((item) => toForwardHeaderRow(item)),
        forwardBodyTemplate: record.forwardBodyTemplate ?? '',
        forwardTimeoutMs: record.forwardTimeoutMs ?? 10000,
        forwardPassthroughQuery: record.forwardPassthroughQuery !== false,
        fields: (record.fields ?? []).map((item) => toFieldRow(item)),
        queryParams: (record.queryParams ?? []).map((item) => toParamRow(item)),
        authEnabled: record.authEnabled !== false,
        rateLimitQps: record.rateLimitQps ?? DEFAULT_DATAAPI_RATE_LIMIT_QPS,
        ipWhitelistText: (record.ipWhitelist ?? []).join('\n'),
      })
    }
    loadDatasources()
    // 编辑回显：builder 模式下预载字段并勾选回显（表清单项由 TableSelect 自动拉取）
    if (
      data?.record &&
      formState.sqlMode === 'builder' &&
      formState.datasourceId &&
      formState.tableName
    ) {
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

  /** 表名清单由 TableSelect 内部拉取（契约 1.9.1），这里只负责选表后的列联动 */
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

  /** 换数据源：表/列/勾选全部重置（表清单由 TableSelect 监听 datasourceId 自动重拉） */
  function handleDatasourceChange() {
    formState.tableName = ''
    metaColumns.value = []
    selectedFieldNames.value = []
    formState.fields = []
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
    formRef.value?.clearValidate?.(['tableName', 'customSql', 'forwardUrl', 'datasourceId'])
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
    if (isForward.value) {
      const urlError = checkForwardUrl(formState.forwardUrl)
      if (urlError) return urlError
      const headers = formState.forwardHeaders ?? []
      if (headers.some((item) => !String(item.name).trim())) return '存在未填写 Header 名的请求头行'
      const declared = new Set(declaredParamNames.value)
      const texts = [
        formState.forwardUrl,
        formState.forwardBodyTemplate,
        ...headers.map((item) => item.value),
      ]
        .filter(Boolean)
        .join(' ')
      const unknown = Array.from(
        new Set(Array.from(texts.matchAll(/:([A-Za-z_][A-Za-z0-9_]{0,63})/g)).map((m) => m[1])),
      ).filter((name) => !declared.has(name))
      if (unknown.length) return `转发配置引用了未声明的查询参数：${unknown.join('、')}`
    } else if (isBuilder.value) {
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
    if (isForward.value) {
      // 1.9.3：转发不查库，只提交转发配置；另一模式字段留空避免污染
      payload.forwardUrl = String(formState.forwardUrl ?? '').trim()
      payload.forwardMethod = formState.forwardMethod
      payload.forwardHeaders = (formState.forwardHeaders ?? [])
        .map((item) => ({ name: String(item.name).trim(), value: String(item.value ?? '').trim() }))
        .filter((item) => item.name)
      payload.forwardBodyTemplate =
        formState.forwardMethod === 'POST' ? String(formState.forwardBodyTemplate ?? '') : null
      payload.forwardTimeoutMs = Number(formState.forwardTimeoutMs ?? 10000)
      payload.forwardPassthroughQuery = formState.forwardPassthroughQuery !== false
      payload.tableName = ''
      payload.customSql = null
      payload.fields = []
      return payload
    }
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
