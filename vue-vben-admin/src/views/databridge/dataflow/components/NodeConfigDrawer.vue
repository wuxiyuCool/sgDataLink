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
        message="Mock 阶段节点配置仅保存与回显，run 时引擎按首尾 input/output 节点模拟执行"
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
    Select,
    Space,
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
  })

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
