<template>
  <Drawer
    :visible="visible"
    :width="520"
    :title="drawerTitle"
    placement="right"
    :mask-closable="false"
    @close="handleCancel"
  >
    <Descriptions v-if="node" :column="1" size="small" class="mb-3">
      <DescriptionsItem label="节点 ID">{{ node.id }}</DescriptionsItem>
      <DescriptionsItem label="组件类型">
        <Tag :color="nodeColor">{{ node.type }}</Tag>
      </DescriptionsItem>
    </Descriptions>

    <Form :label-col="{ span: 6 }" :wrapper-col="{ span: 17 }">
      <FormItem label="节点名称" required>
        <Input v-model:value="form.name" placeholder="例如：读Oracle T_ORDER" />
      </FormItem>

      <!-- input / output：数据源 + 表 -->
      <template v-if="isEndpoint">
        <FormItem label="数据源" required>
          <Select
            v-model:value="form.datasourceId"
            :options="datasourceOptions"
            :loading="datasourceLoading"
            show-search
            option-filter-prop="label"
            :placeholder="node?.type === 'input' ? '请选择读取的源数据源' : '请选择写入的目标数据源'"
            @change="form.table = ''"
          />
        </FormItem>
        <FormItem label="表名" required extra="选定数据源后可输入关键字远程搜索表名">
          <TableSelect v-model:value="form.table" :datasource-id="form.datasourceId" />
        </FormItem>
      </template>
      <FormItem v-if="node?.type === 'output'" label="写入策略">
        <Select v-model:value="form.writeMode" :options="WRITE_MODE_OPTIONS" />
      </FormItem>

      <FormItem v-if="node?.type === 'filter'" label="过滤条件" required>
        <TextArea
          v-model:value="form.condition"
          :rows="3"
          placeholder="例如：STATUS != 'INVALID' AND AMOUNT > 0"
        />
      </FormItem>

      <FormItem v-if="node?.type === 'join'" label="关联方式">
        <Select v-model:value="form.joinType" :options="JOIN_TYPE_OPTIONS" />
      </FormItem>
      <FormItem v-if="node?.type === 'join'" label="关联字段" required>
        <Input v-model:value="form.on" placeholder="例如：ORDER_ID" />
      </FormItem>

      <FormItem v-if="node?.type === 'union'" label="合并来源">
        <Input v-model:value="form.sources" :placeholder="unionPlaceholder" />
      </FormItem>

      <FormItem v-if="node?.type === 'sql'" label="SQL 语句" required>
        <TextArea
          v-model:value="form.sql"
          :rows="8"
          class="sql-text"
          placeholder="select id, amount from t_order where amount > 0"
        />
      </FormItem>

      <template v-if="node?.type === 'json_parse'">
        <FormItem label="待解析字段" required>
          <Input v-model:value="form.field" placeholder="例如：EXT_INFO" />
        </FormItem>
        <FormItem label="JSONPath">
          <Input v-model:value="form.path" placeholder="例如：$.data.amount" />
        </FormItem>
      </template>

      <!-- 1.8.1 真实执行节点：input 读取上限 -->
      <FormItem v-if="node?.type === 'input'" label="读取上限(行)" extra="流水线内存加工的行数护栏，默认 5 万">
        <InputNumber v-model:value="form.limitRows" :min="1" :max="100000" :step="10000" style="width: 160px" />
      </FormItem>

      <!-- 1.8.1 pivot：行列转换 -->
      <template v-if="node?.type === 'pivot'">
        <FormItem label="转换方向">
          <Select v-model:value="form.pivotMode" :options="PIVOT_MODE_OPTIONS" />
        </FormItem>
        <template v-if="form.pivotMode === 'to_columns'">
          <FormItem label="保留列" extra="GROUP BY 维度列，可手输">
            <Select v-model:value="form.groupBy" mode="tags" placeholder="如 ORG_ID,PRODUCE_DT" />
          </FormItem>
          <FormItem label="转列依据列" required>
            <Input v-model:value="form.pivotColumn" placeholder="该列的值会变成列名，如 METRIC_NAME" />
          </FormItem>
          <FormItem label="取值列" required>
            <Input v-model:value="form.valueColumn" placeholder="被聚合的列，如 METRIC_VALUE" />
          </FormItem>
          <FormItem label="聚合方式">
            <Select v-model:value="form.agg" :options="PIVOT_AGG_OPTIONS" />
          </FormItem>
          <FormItem label="固定列清单" extra="留空自动收集值域；值域大时建议显式给出以稳定输出结构">
            <Select v-model:value="form.pivotColumns" mode="tags" placeholder="如 A_NUM,B_NUM" />
          </FormItem>
        </template>
        <template v-else>
          <FormItem label="拆成行的列" required>
            <Select v-model:value="form.unpivotColumns" mode="tags" placeholder="选择要纵向展开的多个列" />
          </FormItem>
          <FormItem label="名称列" extra="记录来源列名的新列">
            <Input v-model:value="form.nameColumn" placeholder="默认 NAME" />
          </FormItem>
          <FormItem label="值列" extra="承载来源列值的新列">
            <Input v-model:value="form.valueColumn" placeholder="默认 VALUE" />
          </FormItem>
        </template>
      </template>

      <!-- 1.8.1 script：JS 脚本加工/爬虫 -->
      <template v-if="node?.type === 'script'">
        <FormItem label="JS 脚本" required :wrapper-col="{ span: 24 }">
          <TextArea
            v-model:value="form.code"
            :rows="10"
            class="sql-text"
            placeholder="const out = []&#10;for (const row of $input) {&#10;  const res = await fetch(row.url)&#10;  out.push({ ID: row.id, BODY: res.text })&#10}&#10;return out"
          />
          <div class="text-gray-500">
            沙箱可用：$input（上游行数组）、$env（下方环境变量）、fetch（仅 http/https、响应 2MB、禁云元址、不跟随重定向）、console（进运行日志）；
            return 数组即下游数据。无 require/process/fs；超时线程强杀，上限 120s。
          </div>
        </FormItem>
        <FormItem label="超时(ms)">
          <InputNumber v-model:value="form.timeoutMs" :min="1000" :max="120000" :step="5000" style="width: 160px" />
        </FormItem>
        <FormItem label="环境变量" extra="JSON 对象注入为 $env，如 {&quot;TOKEN&quot;:&quot;abc&quot;}">
          <TextArea v-model:value="form.envText" :rows="2" placeholder='{"TOKEN":"abc"}' />
        </FormItem>
      </template>

      <!-- 1.8.1 json：JSON 格式化转换 -->
      <template v-if="node?.type === 'json'">
        <FormItem label="转换模式">
          <Select v-model:value="form.jsonMode" :options="JSON_MODE_OPTIONS" />
        </FormItem>
        <FormItem label="目标列" required>
          <Input v-model:value="form.jsonColumn" placeholder="如 PAYLOAD" />
        </FormItem>
        <FormItem v-if="form.jsonMode === 'parse'" label="抽取字段" extra="点路径（a、b.c）可多个；留空则整列转对象">
          <Select v-model:value="form.jsonKeys" mode="tags" placeholder="如 amount,meta.bizNo" />
        </FormItem>
        <FormItem v-if="form.jsonMode !== 'parse'" label="美化缩进">
          <Switch v-model:checked="form.pretty" />
        </FormItem>
        <FormItem label="坏数据策略" extra="null=置空继续 / skip=丢行 / fail=中断报错">
          <Select v-model:value="form.onError" :options="ON_ERROR_OPTIONS" />
        </FormItem>
      </template>

      <FormItem
        v-if="node?.type === 'validate'"
        label="校验规则"
        required
        extra="每行一条规则，例如：ID not null"
      >
        <TextArea v-model:value="form.rulesText" :rows="6" placeholder="ID not null&#10;AMOUNT >= 0" />
      </FormItem>

      <FormItem v-if="node?.type === 'transform'" label="字段映射" :wrapper-col="{ span: 24 }">
        <div class="mb-1 text-gray-500">
          复用同步任务的字段映射编辑器（含转换组件），保存进 config.mappings
        </div>
        <FieldMappingEditor
          v-if="visible"
          :key="editorKey"
          :mappings="form.mappings"
          :show-primary-key="false"
          @change="handleMappingChange"
        />
      </FormItem>

      <Alert
        class="mb-3"
        type="info"
        show-icon
        message="pivot/script/json 三类节点在 mysql 模式下真实执行（契约 1.8.1 流水线，可用「预览加工结果」验证）；其余旧节点仍按引擎快照模拟，流水线中透传不处理"
      />
    </Form>

    <template #footer>
      <Space>
        <Button @click="handleCancel">取消</Button>
        <Button type="primary" @click="handleConfirm">应用配置</Button>
      </Space>
    </template>
  </Drawer>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, watch } from 'vue'
  import {
    Alert,
    Button,
    Descriptions,
    Drawer,
    Form,
    Input,
    InputNumber,
    Select,
    Space,
    Switch,
    Tag,
  } from 'ant-design-vue'
  import { useMessage } from '/@/hooks/web/useMessage'
  import type {
    DataflowNode,
    DataflowNodeConfig,
  } from '/@/api/databridge/model/dataflowModel'
  import type { WriteMode } from '/@/api/databridge/model/commonModel'
  import type { FieldMapping } from '/@/api/databridge/model/taskModel'
  import type { SelectOption } from '../../data'
  import {
    JOIN_TYPE_OPTIONS,
    WRITE_MODE_OPTIONS,
    getDataflowNodeTypeLabel,
    getDataflowNodeTypeColor,
    validateFieldTransforms,
  } from '../../data'
  import FieldMappingEditor from '../../components/FieldMappingEditor.vue'
  import TableSelect from '../../components/TableSelect.vue'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const DescriptionsItem = Descriptions.Item

  const props = defineProps({
    visible: { type: Boolean, default: false },
    /** 当前编辑的节点（父组件从画布 properties 读出） */
    node: { type: Object as () => DataflowNode | null, default: null },
    datasourceOptions: { type: Array as () => SelectOption[], default: () => [] },
    datasourceLoading: { type: Boolean, default: false },
    /** 同画布的其它节点，用于 union/join 提示上游 id */
    siblings: { type: Array as () => DataflowNode[], default: () => [] },
  })

  const emit = defineEmits(['update:visible', 'confirm'])

  const { createMessage } = useMessage()
  const editorKey = ref(0)

  const form = reactive({
    name: '',
    datasourceId: '',
    table: '',
    writeMode: 'upsert' as WriteMode,
    condition: '',
    joinType: 'left',
    on: '',
    sources: '',
    sql: '',
    field: '',
    path: '',
    rulesText: '',
    mappings: [] as FieldMapping[],
    /** 1.8.1 真实执行节点 */
    limitRows: 50000,
    pivotMode: 'to_columns',
    groupBy: [] as string[],
    pivotColumn: '',
    valueColumn: '',
    agg: 'sum',
    pivotColumns: [] as string[],
    unpivotColumns: [] as string[],
    nameColumn: '',
    code: '',
    timeoutMs: 30000,
    envText: '',
    jsonMode: 'parse',
    jsonColumn: '',
    jsonKeys: [] as string[],
    pretty: true,
    onError: 'null',
  })

  const PIVOT_MODE_OPTIONS = [
    { label: '行转列（值变列名 + 聚合）', value: 'to_columns' },
    { label: '列转行（多列拆成 名称/值 两列）', value: 'to_rows' },
  ]
  const PIVOT_AGG_OPTIONS = ['sum', 'count', 'avg', 'min', 'max', 'first'].map((v) => ({ label: v, value: v }))
  const JSON_MODE_OPTIONS = [
    { label: 'parse：JSON 字符串 → 抽字段/对象', value: 'parse' },
    { label: 'stringify：对象 → JSON 字符串', value: 'stringify' },
    { label: 'format：校验并重排格式', value: 'format' },
  ]
  const ON_ERROR_OPTIONS = [
    { label: '置空继续（null）', value: 'null' },
    { label: '丢弃该行（skip）', value: 'skip' },
    { label: '中断报错（fail）', value: 'fail' },
  ]

  const drawerTitle = computed(() => {
    const type = props.node?.type
    return type ? `配置节点 · ${getDataflowNodeTypeLabel(type)}` : '配置节点'
  })

  const nodeColor = computed(() => getDataflowNodeTypeColor(props.node?.type))

  const isEndpoint = computed(() => props.node?.type === 'input' || props.node?.type === 'output')

  const unionPlaceholder = computed(() => {
    const ids = (props.siblings ?? []).map((item) => item.id).slice(0, 6).join(',')
    return ids ? `上游节点 id，逗号分隔，如：${ids}` : '上游节点 id，逗号分隔'
  })

  /** 打开抽屉或切换节点时用节点 config 重置表单 */
  watch(
    () => [props.visible, props.node?.id] as const,
    () => {
      const node = props.node
      if (!props.visible || !node) return
      const config = node.config ?? {}
      Object.assign(form, {
        name: node.name ?? '',
        datasourceId: config.datasourceId ?? '',
        table: config.table ?? '',
        writeMode: (config.writeMode ?? 'upsert') as WriteMode,
        condition: config.condition ?? '',
        joinType: config.joinType ?? 'left',
        on: config.on ?? '',
        sources: config.sources ?? '',
        sql: config.sql ?? '',
        field: config.field ?? '',
        path: config.path ?? '',
        rulesText: (config.rules ?? []).join('\n'),
        mappings: (config.mappings ?? []).map((item) => ({ ...item })),
        limitRows: config.limitRows ?? 50000,
        pivotMode: config.mode === 'to_rows' ? 'to_rows' : 'to_columns',
        groupBy: [...(config.groupBy ?? [])],
        pivotColumn: config.pivotColumn ?? '',
        valueColumn: config.valueColumn ?? '',
        agg: config.agg ?? 'sum',
        pivotColumns: [...(config.columns ?? [])],
        unpivotColumns: [...(config.unpivotColumns ?? [])],
        nameColumn: config.nameColumn ?? '',
        code: config.code ?? '',
        timeoutMs: config.timeoutMs ?? 30000,
        envText: config.env && Object.keys(config.env).length ? JSON.stringify(config.env) : '',
        jsonMode: ['parse', 'stringify', 'format'].includes(String(config.mode)) ? String(config.mode) : 'parse',
        jsonColumn: config.column ?? '',
        jsonKeys: [...(config.keys ?? [])],
        pretty: config.pretty !== false,
        onError: config.onError ?? 'null',
      })
      editorKey.value += 1
    },
    { immediate: true },
  )

  function handleMappingChange(mappings: FieldMapping[]) {
    form.mappings = mappings
  }

  /** 按节点类型收敛出该类型关心的 config 字段，避免脏字段随画布保存 */
  function buildConfig(): DataflowNodeConfig {
    const type = props.node?.type
    const source = props.node?.config ?? {}
    const config: DataflowNodeConfig = {}
    // 坐标由画布维护，这里原样保留（保存时 serializeGraph 会以最新值覆盖）
    if (source.__x !== undefined) config.__x = source.__x
    if (source.__y !== undefined) config.__y = source.__y

    if (isEndpoint.value) {
      config.datasourceId = form.datasourceId
      config.table = form.table
    }
    switch (type) {
      case 'output':
        config.writeMode = form.writeMode
        break
      case 'filter':
        config.condition = form.condition
        break
      case 'join':
        config.joinType = form.joinType as DataflowNodeConfig['joinType']
        config.on = form.on
        break
      case 'union':
        config.sources = form.sources
        break
      case 'sql':
        config.sql = form.sql
        break
      case 'json_parse':
        config.field = form.field
        config.path = form.path
        break
      case 'validate':
        config.rules = String(form.rulesText ?? '')
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean)
        break
      case 'transform':
        config.mappings = form.mappings ?? []
        break
      case 'input':
        config.limitRows = Number(form.limitRows) || 50000
        break
      case 'pivot':
        config.mode = form.pivotMode as DataflowNodeConfig['mode']
        if (form.pivotMode === 'to_columns') {
          config.groupBy = form.groupBy
          config.pivotColumn = form.pivotColumn
          config.valueColumn = form.valueColumn
          config.agg = form.agg as DataflowNodeConfig['agg']
          config.columns = form.pivotColumns
        } else {
          config.unpivotColumns = form.unpivotColumns
          config.nameColumn = form.nameColumn || 'NAME'
          config.valueColumn = form.valueColumn || 'VALUE'
        }
        break
      case 'script': {
        config.code = form.code
        config.timeoutMs = Number(form.timeoutMs) || 30000
        const text = String(form.envText || '').trim()
        if (text) config.env = JSON.parse(text)
        break
      }
      case 'json':
        config.mode = form.jsonMode as DataflowNodeConfig['mode']
        config.column = form.jsonColumn
        config.onError = form.onError as DataflowNodeConfig['onError']
        if (form.jsonMode === 'parse') config.keys = form.jsonKeys
        else config.pretty = form.pretty
        break
      default:
        break
    }
    return config
  }

  function validate(): boolean {
    const type = props.node?.type
    if (!String(form.name ?? '').trim()) {
      createMessage.warning('请填写节点名称')
      return false
    }
    if (isEndpoint.value) {
      if (!form.datasourceId) {
        createMessage.warning('请选择数据源')
        return false
      }
      if (!String(form.table).trim()) {
        createMessage.warning('请填写表名')
        return false
      }
    }
    if (type === 'filter' && !String(form.condition).trim()) {
      createMessage.warning('请填写过滤条件')
      return false
    }
    if (type === 'sql' && !String(form.sql).trim()) {
      createMessage.warning('请填写 SQL 语句')
      return false
    }
    if (type === 'join' && !String(form.on).trim()) {
      createMessage.warning('请填写关联字段')
      return false
    }
    if (type === 'json_parse' && !String(form.field).trim()) {
      createMessage.warning('请填写待解析字段')
      return false
    }
    if (type === 'validate' && !String(form.rulesText).trim()) {
      createMessage.warning('请至少填写一条校验规则')
      return false
    }
    if (type === 'transform') {
      const transformError = validateFieldTransforms(form.mappings ?? [])
      if (transformError) {
        createMessage.warning(transformError)
        return false
      }
    }
    if (type === 'pivot') {
      if (form.pivotMode === 'to_columns' && (!form.pivotColumn.trim() || !form.valueColumn.trim())) {
        createMessage.warning('行转列需要「转列依据列」与「取值列」')
        return false
      }
      if (form.pivotMode === 'to_rows' && !form.unpivotColumns.length) {
        createMessage.warning('列转行需要至少选择一个「拆成行的列」')
        return false
      }
    }
    if (type === 'script') {
      if (!form.code.trim()) {
        createMessage.warning('请填写 JS 脚本')
        return false
      }
      const envText = String(form.envText || '').trim()
      if (envText) {
        try {
          const parsed = JSON.parse(envText)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('')
        } catch {
          createMessage.warning('环境变量需为合法 JSON 对象，如 {"TOKEN":"abc"}')
          return false
        }
      }
    }
    if (type === 'json' && !form.jsonColumn.trim()) {
      createMessage.warning('请填写 JSON 转换的目标列')
      return false
    }
    return true
  }

  function handleConfirm() {
    if (!props.node || !validate()) return
    emit('confirm', {
      id: props.node.id,
      name: String(form.name).trim(),
      config: buildConfig(),
    })
    emit('update:visible', false)
  }

  function handleCancel() {
    emit('update:visible', false)
  }
</script>
<style lang="less" scoped>
  .sql-text {
    font-family: monospace;
  }
</style>
