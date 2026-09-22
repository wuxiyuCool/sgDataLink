import type { DatasourceType } from '/@/api/databridge/model/datasourceModel'
import type {
  FieldMapping,
  FieldTransformType,
  Task,
  TaskPayload,
} from '/@/api/databridge/model/taskModel'
import type {
  ExecMode,
  InstanceTrigger,
  LogLevel,
  SyncMode,
  TaskLastStatus,
  WriteMode,
} from '/@/api/databridge/model/commonModel'
import type {
  Pipeline,
  PipelineDdlPolicy,
  PipelinePayload,
  PipelineStatus,
} from '/@/api/databridge/model/pipelineModel'
import type {
  Dataflow,
  DataflowNode,
  DataflowNodeType,
  DataflowPayload,
} from '/@/api/databridge/model/dataflowModel'
import type {
  DataApi,
  DataApiFieldType,
  DataApiMethod,
  DataApiPayload,
  DataApiStatus,
} from '/@/api/databridge/model/dataapiModel'
import type {
  AlertChannelType,
  AlertCondition,
  AlertRule,
  AlertRulePayload,
} from '/@/api/databridge/model/alertModel'
import type { LineageNodeType } from '/@/api/databridge/model/lineageModel'
import { dateUtil } from '/@/utils/dateUtil'

/** 轮询间隔：docs/API.md 第 3 节约定 mock 阶段用 3s setInterval */
export const POLL_INTERVAL = 3000

/** ant-design-vue Table 列定义（避免依赖组件库内部类型导出） */
export interface TableColumn {
  title: string
  dataIndex?: string
  key?: string
  width?: number | string
  minWidth?: number | string
  align?: 'left' | 'center' | 'right'
  fixed?: 'left' | 'right' | boolean
  ellipsis?: boolean
  className?: string
  customRender?: (opt: { text: any; record: any; index: number }) => any
}

export interface SelectOption {
  label: string
  value: string | number | boolean
}

export const DATASOURCE_TYPE_OPTIONS: SelectOption[] = [
  { label: 'Oracle', value: 'oracle' },
  { label: 'MySQL', value: 'mysql' },
  { label: 'PostgreSQL', value: 'postgresql' },
]

export const DATASOURCE_TYPE_LABELS: Record<DatasourceType, string> = {
  oracle: 'Oracle',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
}

/** 各类型的默认端口，新增时联动填充 */
export const DATASOURCE_DEFAULT_PORT: Record<DatasourceType, number> = {
  oracle: 1521,
  mysql: 3306,
  postgresql: 5432,
}

export const DATASOURCE_TYPE_TAG_COLORS: Record<DatasourceType, string> = {
  oracle: 'red',
  mysql: 'blue',
  postgresql: 'green',
}

export const DATASOURCE_STATUS_OPTIONS: SelectOption[] = [
  { label: '启用', value: 'enabled' },
  { label: '停用', value: 'disabled' },
]

export const DATASOURCE_STATUS_LABELS: Record<string, string> = {
  enabled: '启用',
  disabled: '停用',
}

export const SYNC_MODE_OPTIONS: SelectOption[] = [
  { label: '全量同步', value: 'full' },
  { label: '增量同步', value: 'incremental' },
]

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  full: '全量',
  incremental: '增量',
  /** cdc 模式由「数据管道」承载，同步任务表单不提供该选项（见 SYNC_MODE_OPTIONS） */
  cdc: '实时管道',
}

export const SYNC_MODE_TAG_COLORS: Record<SyncMode, string> = {
  full: 'purple',
  incremental: 'cyan',
  cdc: 'geekblue',
}

export const TASK_STATUS_OPTIONS: SelectOption[] = [
  { label: '空闲', value: 'idle' },
  { label: '运行中', value: 'running' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' },
  { label: '已停止', value: 'stopped' },
]

export const TASK_STATUS_LABELS: Record<TaskLastStatus, string> = {
  idle: '空闲',
  running: '运行中',
  success: '成功',
  failed: '失败',
  stopped: '已停止',
}

export const TASK_STATUS_TAG_COLORS: Record<TaskLastStatus, string> = {
  idle: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  stopped: 'warning',
}

export const WRITE_MODE_OPTIONS: SelectOption[] = [
  { label: 'insert（仅插入）', value: 'insert' },
  { label: 'upsert（存在则更新）', value: 'upsert' },
  { label: 'overwrite（先清空再写入）', value: 'overwrite' },
]

/**
 * 字段转换下拉（对标 FDL 转换组件占位，契约 1.2 fieldMappings[].transform）
 * Mock 阶段仅随任务保存 / 回显，不参与模拟执行
 */
export const FIELD_TRANSFORM_OPTIONS: SelectOption[] = [
  { label: '无', value: 'none' },
  { label: '转大写', value: 'upper' },
  { label: '转小写', value: 'lower' },
  { label: '去空格', value: 'trim' },
  { label: '常量', value: 'constant' },
  { label: '表达式', value: 'expression' },
]

/** 只有常量 / 表达式两类需要额外填写 value */
export const TRANSFORM_VALUE_TYPES: FieldTransformType[] = ['constant', 'expression']

export function needTransformValue(type?: FieldTransformType | null) {
  return !!type && TRANSFORM_VALUE_TYPES.includes(type)
}

/**
 * 校验映射行的转换配置：constant / expression 必须填写非空 value
 * （后端 validations/task.validation.js 同规则，缺失会返回 40001）
 * @returns 校验通过返回空字符串，否则返回可直接展示的提示文案
 */
export function validateFieldTransforms(list: FieldMapping[]): string {
  const invalid = (list ?? []).find(
    (item) =>
      needTransformValue(item.transform?.type) && !String(item.transform?.value ?? '').trim(),
  )
  if (!invalid) return ''
  const label = invalid.transform?.type === 'constant' ? '常量' : '表达式'
  return `字段【${invalid.sourceField || '-'}】的转换类型为${label}，请填写对应的值`
}

export const LOG_LEVEL_OPTIONS: SelectOption[] = [
  { label: 'INFO', value: 'INFO' },
  { label: 'WARN', value: 'WARN' },
  { label: 'ERROR', value: 'ERROR' },
]

export const LOG_LEVEL_TAG_COLORS: Record<LogLevel, string> = {
  INFO: 'blue',
  WARN: 'orange',
  ERROR: 'red',
}

export const WRITE_MODE_LABELS: Record<WriteMode, string> = {
  insert: 'insert',
  upsert: 'upsert',
  overwrite: 'overwrite',
}

export function getSyncModeLabel(mode?: SyncMode) {
  return mode ? SYNC_MODE_LABELS[mode] : '-'
}

export function getTaskStatusLabel(status?: TaskLastStatus) {
  return status ? TASK_STATUS_LABELS[status] : '-'
}

export function getTaskStatusColor(status?: TaskLastStatus) {
  return status ? TASK_STATUS_TAG_COLORS[status] : 'default'
}

export function getDatasourceTypeLabel(type?: DatasourceType) {
  return type ? DATASOURCE_TYPE_LABELS[type] : '-'
}

/** 千分位数字格式化，空值返回 0 */
export function formatNumber(value?: number | null) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return '0'
  return Number(value).toLocaleString('en-US')
}

/** ISO 8601 -> YYYY-MM-DD HH:mm:ss，空值返回 '-' */
export function formatTime(value?: string | null, format = 'YYYY-MM-DD HH:mm:ss') {
  if (!value) return '-'
  const date = dateUtil(value)
  return date.isValid() ? date.format(format) : String(value)
}

/** 时间轴采样点标签 HH:mm:ss */
export function formatTimeAxis(value?: string | number | null) {
  const date = dateUtil(value)
  return date.isValid() ? date.format('HH:mm:ss') : ''
}

/** Progress 组件状态映射 */
export function getProgressStatus(status?: TaskLastStatus): 'active' | 'normal' | 'success' | 'exception' {
  if (status === 'failed' || status === 'stopped') return 'exception'
  if (status === 'success') return 'success'
  if (status === 'running') return 'active'
  return 'normal'
}

/** 任务请求体允许携带的可选字段（调度配置与字段映射转换都在其中） */
const TASK_PAYLOAD_KEYS: (keyof Task)[] = [
  'writeMode',
  'batchSize',
  'incrementalColumn',
  'scheduleCron',
  'retryCount',
  'retryIntervalSec',
  'fieldMappings',
  'enabled',
]

/**
 * 由任务对象裁剪出 POST /tasks、PUT /tasks/:id 的请求体。
 * 后端 validations/task.validation.js 用 Joi 严格校验（未开 stripUnknown），
 * id / lastStatus / createdAt / progress 等响应侧字段一旦回传就会 40001，
 * 因此编辑保存前统一走本方法，只提交契约 1.2 的请求字段。
 */
export function pickTaskPayload(task: Task): TaskPayload {
  const payload: TaskPayload = {
    name: task.name,
    syncMode: task.syncMode,
    sourceId: task.sourceId,
    sourceTable: task.sourceTable,
    targetId: task.targetId,
    targetTable: task.targetTable,
  }
  const holder = payload as Recordable
  TASK_PAYLOAD_KEYS.forEach((key) => {
    const value = task[key]
    // null 需要显式提交（如 scheduleCron: null 表示改回手动触发）
    if (value !== undefined) holder[key] = value
  })
  return payload
}

/* ------------------------------------------------------------------ */
/* 以下为 FineDataLink 对标四模块（契约 1.7 ~ 1.10）新增的共享常量与工具 */
/* ------------------------------------------------------------------ */

/**
 * 与 pickTaskPayload 同样的约定：后端 Joi 严格校验（未开 stripUnknown），
 * 请求体只提交契约列出的字段，id / status / lastStatus / 统计量等响应侧字段一律不回传。
 */
const PIPELINE_PAYLOAD_KEYS: (keyof Pipeline)[] = ['ddlPolicy', 'cdcPollColumn', 'pollIntervalSec']

/** 裁剪 PUT/POST /pipelines 请求体（契约 1.7） */
export function pickPipelinePayload(pipeline: Pipeline): PipelinePayload {
  const payload: PipelinePayload = {
    name: pipeline.name,
    sourceId: pipeline.sourceId,
    targetId: pipeline.targetId,
    syncObjects: (pipeline.syncObjects ?? []).map((item) => String(item).trim()).filter(Boolean),
  }
  const holder = payload as Recordable
  PIPELINE_PAYLOAD_KEYS.forEach((key) => {
    const value = pipeline[key]
    if (value !== undefined) holder[key] = value
  })
  return payload
}

/** 裁剪 PUT/POST /dataflows 请求体（契约 1.8） */
export function pickDataflowPayload(dataflow: Dataflow): DataflowPayload {
  const nodes: DataflowNode[] = (dataflow.nodes ?? []).map((node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
    config: node.config ?? {},
  }))
  return {
    name: dataflow.name,
    nodes,
    edges: (dataflow.edges ?? []).map((edge) => ({ source: edge.source, target: edge.target })),
    scheduleCron: dataflow.scheduleCron ?? null,
    retryCount: dataflow.retryCount ?? 0,
    retryIntervalSec: dataflow.retryIntervalSec ?? 60,
    enabled: dataflow.enabled !== false,
  }
}

/** 裁剪 PUT/POST /data-apis 请求体（契约 1.9） */
export function pickDataApiPayload(api: DataApi): DataApiPayload {
  return {
    name: api.name,
    path: api.path,
    method: (api.method || 'GET') as DataApiMethod,
    datasourceId: api.datasourceId,
    tableName: api.tableName,
    fields: (api.fields ?? []).map((field) => ({ name: field.name, type: field.type })),
    queryParams: (api.queryParams ?? []).map((item) => ({
      name: item.name,
      type: item.type,
      required: !!item.required,
    })),
    authEnabled: api.authEnabled !== false,
    rateLimitQps: Number(api.rateLimitQps ?? DEFAULT_DATAAPI_RATE_LIMIT_QPS),
    ipWhitelist: (api.ipWhitelist ?? []).map((item) => String(item).trim()).filter(Boolean),
  }
}

/** 裁剪 PUT/POST /alert-rules 请求体（契约 1.10） */
export function pickAlertRulePayload(rule: AlertRule): AlertRulePayload {
  return {
    name: rule.name,
    scope: rule.scope || 'all',
    conditions: [...(rule.conditions ?? [])],
    thresholdLagMs: rule.thresholdLagMs ?? null,
    channels: (rule.channels ?? []).map((channel) => ({
      type: channel.type,
      webhook: String(channel.webhook ?? '').trim(),
    })),
    enabled: rule.enabled !== false,
  }
}

/* ---------------------------- 实例触发方式（1.6） ---------------------------- */

export const TRIGGER_OPTIONS: SelectOption[] = [
  { label: '手动触发', value: 'manual' },
  { label: '定时调度', value: 'cron' },
  { label: '失败重试', value: 'retry' },
]

export const TRIGGER_LABELS: Record<InstanceTrigger, string> = {
  manual: '手动',
  cron: '定时',
  retry: '重试',
}

export const TRIGGER_TAG_COLORS: Record<InstanceTrigger, string> = {
  manual: 'default',
  cron: 'blue',
  retry: 'orange',
}

export function getTriggerLabel(trigger?: InstanceTrigger) {
  return trigger ? TRIGGER_LABELS[trigger] : '-'
}

export function getTriggerColor(trigger?: InstanceTrigger) {
  return trigger ? TRIGGER_TAG_COLORS[trigger] : 'default'
}

/* --------------------------- 执行模式（契约 4.1） --------------------------- */

/**
 * 执行模式由 Node 下发引擎快照时判定：DB_DRIVER=mysql 且端点类型均受驱动支持才是 real，
 * 否则 simulate（进度/行数为模拟值）。老数据可能没有该字段，前端不显示标识。
 */
export const EXEC_MODE_LABELS: Record<ExecMode, string> = {
  real: '真实',
  simulate: '模拟',
}

export const EXEC_MODE_TAG_COLORS: Record<ExecMode, string> = {
  real: 'green',
  simulate: 'orange',
}

/** 模拟执行的原因说明：悬浮在「模拟」Tag 上 */
export const EXEC_MODE_SIMULATE_TIP = '数据源类型或驱动不支持真实读写，本次进度为模拟值'

/** 真实执行说明：悬浮在「真实」Tag 上 */
export const EXEC_MODE_REAL_TIP = '端点驱动支持真实读写，本次进度与行数来自实际执行'

/** 是否模拟执行（execMode 缺失时按未知处理，不显示标识） */
export function isSimulateExec(mode?: ExecMode) {
  return mode === 'simulate'
}

export function getExecModeLabel(mode?: ExecMode) {
  return mode ? EXEC_MODE_LABELS[mode] : '-'
}

export function getExecModeColor(mode?: ExecMode) {
  return mode ? EXEC_MODE_TAG_COLORS[mode] : 'default'
}

/* ------------------------------ 数据管道（1.7） ------------------------------ */

export const PIPELINE_STATUS_OPTIONS: SelectOption[] = [
  { label: '运行中', value: 'running' },
  { label: '已停止', value: 'stopped' },
]

export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  running: '运行中',
  stopped: '已停止',
}

export const PIPELINE_STATUS_TAG_COLORS: Record<PipelineStatus, string> = {
  running: 'processing',
  stopped: 'default',
}

/** DDL 变更策略（Mock 阶段仅存储回显） */
export const DDL_POLICY_OPTIONS: SelectOption[] = [
  { label: 'ignore（忽略变更）', value: 'ignore' },
  { label: 'report（仅上报变更）', value: 'report' },
]

export const DDL_POLICY_LABELS: Record<PipelineDdlPolicy, string> = {
  ignore: 'ignore 忽略',
  report: 'report 上报',
}

export const DEFAULT_DDL_POLICY: PipelineDdlPolicy = 'ignore'

/**
 * 同步延迟展示阈值（毫秒）：与契约 1.10 告警规则 thresholdLagMs 的示例值一致，
 * 列表中超过该阈值的单元格标红，与「延迟超阈值」告警形成呼应
 */
export const LAG_THRESHOLD_MS = 5000

export function getPipelineStatusLabel(status?: PipelineStatus) {
  return status ? PIPELINE_STATUS_LABELS[status] : '-'
}

export function getPipelineStatusColor(status?: PipelineStatus) {
  return status ? PIPELINE_STATUS_TAG_COLORS[status] : 'default'
}

export function isLagOverThreshold(lagMs?: number | null) {
  if (lagMs === undefined || lagMs === null) return false
  return Number(lagMs) > LAG_THRESHOLD_MS
}

/** 延迟文案：820 ms / 6.2 s，便于列内快速扫读 */
export function formatLag(lagMs?: number | null) {
  if (lagMs === undefined || lagMs === null || Number.isNaN(Number(lagMs))) return '-'
  const value = Number(lagMs)
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
}

/* ------------------------------ 数据开发（1.8） ------------------------------ */

export interface DataflowNodeMeta {
  type: DataflowNodeType
  /** 组件面板与节点标题展示名 */
  label: string
  /** 面板副标题说明 */
  desc: string
  /** 节点配色（画布内联样式 + 图例） */
  color: string
  icon: string
}

/** 画布组件清单：与契约 1.8 节点 type 枚举一一对应 */
export const DATAFLOW_NODE_TYPES: DataflowNodeMeta[] = [
  {
    type: 'input',
    label: '数据输入',
    desc: '读取源表',
    color: '#1890ff',
    icon: 'ant-design:download-outlined',
  },
  {
    type: 'output',
    label: '数据输出',
    desc: '写入目标表',
    color: '#52c41a',
    icon: 'ant-design:upload-outlined',
  },
  {
    type: 'filter',
    label: '过滤',
    desc: '按条件筛行',
    color: '#faad14',
    icon: 'ant-design:filter-outlined',
  },
  {
    type: 'transform',
    label: '字段转换',
    desc: '映射与转换',
    color: '#13c2c2',
    icon: 'ant-design:swap-outlined',
  },
  {
    type: 'join',
    label: '关联',
    desc: '按 key 横向关联',
    color: '#722ed1',
    icon: 'ant-design:merge-cells-outlined',
  },
  {
    type: 'union',
    label: '合并',
    desc: '多流纵向合并',
    color: '#eb2f96',
    icon: 'ant-design:branch-lines-outlined',
  },
  {
    type: 'sql',
    label: 'SQL',
    desc: '自定义 SQL',
    color: '#2f54eb',
    icon: 'ant-design:code-outlined',
  },
  {
    type: 'json_parse',
    label: 'JSON 解析',
    desc: '展开 JSON 字段',
    color: '#fa8c16',
    icon: 'ant-design:brackets-outlined',
  },
  {
    type: 'validate',
    label: '质量校验',
    desc: '规则校验',
    color: '#f5222d',
    icon: 'ant-design:afety-certificate-outlined',
  },
]

export const DATAFLOW_NODE_TYPE_MAP = DATAFLOW_NODE_TYPES.reduce((map, item) => {
  map[item.type] = item
  return map
}, {} as Record<DataflowNodeType, DataflowNodeMeta>)

export const DATAFLOW_NODE_TYPE_OPTIONS: SelectOption[] = DATAFLOW_NODE_TYPES.map((item) => ({
  label: `${item.label}（${item.type}）`,
  value: item.type,
}))

/** join 关联方式（契约 1.8 config.joinType） */
export const JOIN_TYPE_OPTIONS: SelectOption[] = [
  { label: 'left（左连接）', value: 'left' },
  { label: 'right（右连接）', value: 'right' },
  { label: 'inner（内连接）', value: 'inner' },
  { label: 'full（全连接）', value: 'full' },
]

export function getDataflowNodeTypeLabel(type?: DataflowNodeType) {
  return type ? DATAFLOW_NODE_TYPE_MAP[type]?.label ?? type : '-'
}

export function getDataflowNodeTypeColor(type?: DataflowNodeType) {
  return type ? DATAFLOW_NODE_TYPE_MAP[type]?.color ?? '#8c8c8c' : '#8c8c8c'
}

/** 新增节点时的默认名称，与契约示例命名风格一致 */
export function getDataflowNodeDefaultName(type: DataflowNodeType) {
  return getDataflowNodeTypeLabel(type)
}

/* ----------------------------- 数据服务（1.9） ------------------------------ */

export const DATAAPI_STATUS_OPTIONS: SelectOption[] = [
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
]

export const DATAAPI_STATUS_LABELS: Record<DataApiStatus, string> = {
  draft: '草稿',
  published: '已发布',
}

export const DATAAPI_STATUS_TAG_COLORS: Record<DataApiStatus, string> = {
  draft: 'default',
  published: 'success',
}

export const DATAAPI_METHOD_OPTIONS: SelectOption[] = [
  { label: 'GET', value: 'GET' },
  { label: 'POST', value: 'POST' },
]

/** 输出字段类型（契约 1.9 fields[].type） */
export const DATAAPI_FIELD_TYPE_OPTIONS: SelectOption[] = [
  'BIGINT',
  'DECIMAL',
  'VARCHAR',
  'DATE',
  'BOOLEAN',
].map((item) => ({ label: item, value: item })) as SelectOption[]

/** 查询参数类型，与运行时按字符串解析保持一致 */
export const DATAAPI_QUERY_TYPE_OPTIONS: SelectOption[] = [
  { label: 'string', value: 'string' },
  { label: 'number', value: 'number' },
  { label: 'date', value: 'date' },
  { label: 'boolean', value: 'boolean' },
]

export const DEFAULT_DATAAPI_RATE_LIMIT_QPS = 50

export const DATAAPI_FIELD_TYPES: DataApiFieldType[] = [
  'BIGINT',
  'DECIMAL',
  'VARCHAR',
  'DATE',
  'BOOLEAN',
]

export function getDataApiStatusLabel(status?: DataApiStatus) {
  return status ? DATAAPI_STATUS_LABELS[status] : '-'
}

export function getDataApiStatusColor(status?: DataApiStatus) {
  return status ? DATAAPI_STATUS_TAG_COLORS[status] : 'default'
}

/* ------------------------------ 告警管理（1.10） ------------------------------ */

export const ALERT_CONDITION_OPTIONS: SelectOption[] = [
  { label: '同步任务失败（task_failed）', value: 'task_failed' },
  { label: '数据管道异常（pipeline_error）', value: 'pipeline_error' },
  { label: '管道延迟超阈值（lag_over_threshold）', value: 'lag_over_threshold' },
]

export const ALERT_CONDITION_LABELS: Record<AlertCondition, string> = {
  task_failed: '任务失败',
  pipeline_error: '管道异常',
  lag_over_threshold: '延迟超阈值',
}

export const ALERT_CHANNEL_OPTIONS: SelectOption[] = [
  { label: '钉钉机器人', value: 'dingtalk' },
  { label: '企业微信机器人', value: 'wecom' },
  { label: '邮件', value: 'email' },
]

export const ALERT_CHANNEL_LABELS: Record<AlertChannelType, string> = {
  dingtalk: '钉钉',
  wecom: '企业微信',
  email: '邮件',
}

/** 生效范围：契约示例仅 all，第二阶段可按任务/管道粒度扩展 */
export const ALERT_SCOPE_OPTIONS: SelectOption[] = [
  { label: '全部对象（all）', value: 'all' },
]

export const ALERT_LEVEL_OPTIONS = LOG_LEVEL_OPTIONS

export const ALERT_READ_OPTIONS: SelectOption[] = [
  { label: '未读', value: false },
  { label: '已读', value: true },
]

export const DEFAULT_ALERT_THRESHOLD_LAG_MS = LAG_THRESHOLD_MS

export function getAlertConditionLabel(condition: AlertCondition | string) {
  return ALERT_CONDITION_LABELS[condition as AlertCondition] || condition
}

export function getAlertChannelLabel(channel?: AlertChannelType) {
  return channel ? ALERT_CHANNEL_LABELS[channel] || channel : '-'
}

/* ------------------------------ 数据血缘（1.10） ------------------------------ */

export interface LineageNodeMeta {
  label: string
  color: string
}

/** 节点按 type 分色（契约要求 datasource 蓝 / table 绿 / task 橙 / pipeline 紫 / dataflow 青 / dataapi 红） */
export const LINEAGE_NODE_META: Record<LineageNodeType, LineageNodeMeta> = {
  datasource: { label: '数据源', color: '#1890ff' },
  table: { label: '数据表', color: '#52c41a' },
  task: { label: '同步任务', color: '#fa8c16' },
  pipeline: { label: '数据管道', color: '#722ed1' },
  dataflow: { label: '数据开发', color: '#13c2c2' },
  dataapi: { label: '数据服务', color: '#f5222d' },
}

export const LINEAGE_NODE_TYPE_ORDER: LineageNodeType[] = [
  'datasource',
  'table',
  'task',
  'pipeline',
  'dataflow',
  'dataapi',
]

export function getLineageNodeLabel(type?: LineageNodeType) {
  return type ? LINEAGE_NODE_META[type]?.label ?? type : '-'
}

export function getLineageNodeColor(type?: LineageNodeType) {
  return type ? LINEAGE_NODE_META[type]?.color ?? '#8c8c8c' : '#8c8c8c'
}
