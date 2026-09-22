import type { StatisticsTrendItem, TaskModeCountMode } from '/@/api/databridge/statistics'
import type { DatasourceType } from '/@/api/databridge/model/datasourceModel'
import type { TaskInstance } from '/@/api/databridge/model/taskInstanceModel'
import type { DataApiCallItem } from '/@/api/databridge/model/dataapiModel'
import type { TableColumn } from '/@/views/databridge/data'
import { POLL_INTERVAL } from '/@/views/databridge/data'

/**
 * 「可视化监控」四页（总览 / 运行 / 管道 / 服务）的视觉与取数约定统一收敛在这里：
 * 色板沿用全站 Tag 语义色（成功绿 / 失败红 / 运行蓝 / 警告橙 / 管道紫 / 服务青），
 * 图表按「类别 -> 固定色」取色而不是依赖 ECharts 随机序，保证刷新前后颜色不跳。
 */
export const DASH_COLORS = {
  success: '#52c41a',
  failed: '#ff4d4f',
  running: '#1890ff',
  warning: '#faad14',
  pipeline: '#722ed1',
  service: '#13c2c2',
  neutral: '#8c8c8c',
}

/** 饼图 / 环形图按序取色的统一色板 */
export const CHART_PALETTE = ['#1890ff', '#722ed1', '#13c2c2', '#faad14', '#52c41a', '#ff4d4f']

/** 图表数据项：名称 + 数量 + 类别固定色（缺省按色板顺序取色） */
export interface ChartDatum {
  name: string
  value: number
  color?: string
}

/**
 * 轮询纪律（契约 3 节）：
 * - 运行中实例 / 管道实时状态 3s（复用全站 POLL_INTERVAL）
 * - 日志流、数据服务调用明细 10s（可关）
 * - KPI / 图表 30s
 */
export const RUNNING_POLL_INTERVAL = POLL_INTERVAL
export const LOG_POLL_INTERVAL = 10_000
export const OVERVIEW_POLL_INTERVAL = 30_000
/** 管道指标轮询（GET /pipelines/:id/status） */
export const PIPELINE_POLL_INTERVAL = POLL_INTERVAL
/** 调用明细轮询（GET /data-apis/calls） */
export const CALLS_POLL_INTERVAL = LOG_POLL_INTERVAL

/** 单实例进度曲线的本地采样点上限（约 3 分钟） */
export const MAX_PROGRESS_SAMPLES = 60

export interface InstanceModeMeta {
  label: string
  color: string
  icon: string
  desc: string
}

/** 任务模式分布的展示元数据（cdc = 数据管道，dataflow = 数据开发，契约 1.5） */
export const TASK_MODE_META: Record<TaskModeCountMode, InstanceModeMeta> = {
  full: {
    label: '全量同步',
    color: DASH_COLORS.running,
    icon: 'ant-design:database-outlined',
    desc: '整表覆盖式同步',
  },
  incremental: {
    label: '增量同步',
    color: DASH_COLORS.service,
    icon: 'ant-design:step-forward-outlined',
    desc: '按位点增量拉取',
  },
  cdc: {
    label: '数据管道',
    color: DASH_COLORS.pipeline,
    icon: 'ant-design:pulse-outlined',
    desc: 'CDC 实时镜像',
  },
  dataflow: {
    label: '数据开发',
    color: DASH_COLORS.warning,
    icon: 'ant-design:partition-outlined',
    desc: 'ETL 编排画布',
  },
}

/** 数据源类型配色与 DATASOURCE_TYPE_TAG_COLORS（red/blue/green）保持一致 */
export const DATASOURCE_TYPE_CHART_COLORS: Record<DatasourceType, string> = {
  oracle: '#ff4d4f',
  mysql: '#1890ff',
  postgresql: '#52c41a',
}

/** 日志级别圆点/文字色（比 Tag 更克制，用于日志流与告警流） */
export const LOG_LEVEL_COLORS: Record<string, string> = {
  INFO: DASH_COLORS.running,
  WARN: DASH_COLORS.warning,
  ERROR: DASH_COLORS.failed,
}

export function getLogLevelColor(level?: string | null) {
  return (level && LOG_LEVEL_COLORS[level]) || DASH_COLORS.neutral
}

/**
 * 运行实例归属类型：管道实例带 pipelineId，数据开发实例用 taskId 承载 dataflowId（契约 1.8），
 * 其余为同步任务实例。与后端 id 前缀约定（pipe- / df-）一致。
 */
export type InstanceKind = 'pipeline' | 'dataflow' | 'task'

export const INSTANCE_KIND_META: Record<InstanceKind, InstanceModeMeta> = {
  pipeline: {
    label: '数据管道',
    color: DASH_COLORS.pipeline,
    icon: 'ant-design:pulse-outlined',
    desc: 'CDC 持续捕获',
  },
  dataflow: {
    label: '数据开发',
    color: DASH_COLORS.warning,
    icon: 'ant-design:partition-outlined',
    desc: 'ETL 画布运行体',
  },
  task: {
    label: '同步任务',
    color: DASH_COLORS.running,
    icon: 'ant-design:swap-outlined',
    desc: '全量/增量批量',
  },
}

export function instanceKindOf(row: TaskInstance): InstanceKind {
  if (row.pipelineId) return 'pipeline'
  if (String(row.taskId || '').startsWith('df-')) return 'dataflow'
  return 'task'
}

export function instanceKindMetaOf(row: TaskInstance) {
  return INSTANCE_KIND_META[instanceKindOf(row)]
}

export function isPipelineInstance(row: TaskInstance) {
  return instanceKindOf(row) === 'pipeline'
}

/** 单个实例的本地进度采样点（时间轴为浏览器本地时间，仅存在于页面内存） */
export interface ProgressSample {
  time: string
  progress: number
  readRows: number
  writeRows: number
  rate: number
}

/** 运行中实例行：实例字段 + 管道/任务进度接口补充的运行态 */
export interface RunningRow extends TaskInstance {
  /** 管道：累计变更行数 */
  changeRows?: number | null
  /** 管道：当前 QPS（任务实例用 rateRowsPerSec） */
  currentQps?: number | null
  /** 管道：同步延迟（毫秒） */
  lagMs?: number | null
  /** 管道：CDC 位点 */
  cdcPosition?: string | null
  /** 管道最近一次异常 */
  lastError?: string | null
  /** 该行最近一次刷新时间（本地时间戳） */
  updatedAtLocal?: number
}

/** 趋势合计，用于 KPI 卡副标题与成功率兜底计算 */
export function sumTrend(trend: StatisticsTrendItem[]) {
  return (trend || []).reduce(
    (acc, item) => ({
      success: acc.success + Number(item.success || 0),
      failed: acc.failed + Number(item.failed || 0),
    }),
    { success: 0, failed: 0 },
  )
}

/**
 * 成功率阈值配色（仪表盘色）：>=95 绿 / >=80 橙 / 其余红，无数据灰。
 */
export function successRateColor(rate?: number | null) {
  if (rate === undefined || rate === null || Number.isNaN(Number(rate))) return DASH_COLORS.neutral
  const value = Number(rate)
  if (value >= 95) return DASH_COLORS.success
  if (value >= 80) return DASH_COLORS.warning
  return DASH_COLORS.failed
}

/** 成功率文案：保留 1 位小数并带百分号，无数据返回 '-' */
export function formatRate(rate?: number | null) {
  if (rate === undefined || rate === null || Number.isNaN(Number(rate))) return '-'
  return `${Number(rate).toFixed(1)}%`
}

/** 运行时长文案：毫秒 -> 1h 22m 30s / 45s（用于「已运行」提示） */
export function formatDuration(ms?: number | null) {
  if (!ms || ms < 0) return '-'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** 运行中实例表列（宽度合计用于 x 滚动） */
export const runningInstanceColumns: TableColumn[] = [
  { title: '运行实例', dataIndex: 'id', key: 'id', width: 120 },
  { title: '名称 / 归属', dataIndex: 'taskName', key: 'name', width: 220, ellipsis: true },
  { title: '模式', dataIndex: 'syncMode', key: 'syncMode', width: 110 },
  { title: '状态', dataIndex: 'status', key: 'status', width: 165 },
  { title: '进度', key: 'progress', width: 170 },
  { title: '读 / 写(变更)行数', key: 'rows', width: 170 },
  { title: '速率', key: 'rate', width: 120, align: 'right' },
  { title: '位点 / 延迟', key: 'position', width: 220, ellipsis: true },
  { title: '开始时间', key: 'startedAt', width: 170 },
]

/** 实时日志流列 */
export const logStreamColumns: TableColumn[] = [
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 180 },
  { title: '级别', dataIndex: 'level', key: 'level', width: 90 },
  { title: '来源', dataIndex: 'taskName', key: 'taskName', width: 180, ellipsis: true },
  { title: '日志内容', dataIndex: 'message', key: 'message', ellipsis: true },
  { title: '实例', dataIndex: 'instanceId', key: 'instanceId', width: 120 },
]

/** 数据服务 TOP5 迷你表列 */
export const topDataApiColumns: TableColumn[] = [
  { title: '服务', dataIndex: 'name', key: 'name', width: 150, ellipsis: true },
  { title: '路径', dataIndex: 'path', key: 'path', width: 130, ellipsis: true },
  { title: '调用量', key: 'invokeCount', width: 130, align: 'right' },
  { title: '错误', key: 'errorCount', width: 70, align: 'right' },
  { title: '平均延迟', key: 'avgLatencyMs', width: 100, align: 'right' },
]

/** 空态文案统一从这里出，避免各卡片各写一套 */
export const DASH_EMPTY_TEXT = {
  running: '当前没有运行中的任务或管道',
  alerts: '暂无告警',
  logs: '暂无运行日志',
  dataApis: '暂无已发布的数据服务',
  trend: '近 7 天没有执行记录',
  pipeline: '还没有数据管道，去「数据管道」页新建一条即可接入 CDC 监控',
  calls: '暂无调用明细（后端 /data-apis/calls 交付后自动出现）',
  trace: '暂无采样点',
} as const

/* ------------------------------------------------------------------ */
/* 管道监控页：本地采样曲线与指标卡                                      */
/* ------------------------------------------------------------------ */

/** 管道 QPS / 延迟曲线的滚动窗口大小（3s 采样 ≈ 3 分钟） */
export const PIPELINE_SAMPLE_WINDOW = 60

/** 单个采样点：来自 GET /pipelines/:id/status 的一次读数（仅存内存，不落库） */
export interface PipelineSample {
  time: string
  qps: number
  lagMs: number
  changeRows: number
}

/** 管道当前指标卡定义（大数字卡，值取自最近一次 status 轮询） */
export interface PipelineMetricMeta {
  key: 'currentQps' | 'lagMs' | 'changeRows' | 'cdcPosition'
  title: string
  icon: string
  color: string
  /** 悬浮提示：说明口径与接口字段 */
  tip: string
}

export const PIPELINE_METRICS: PipelineMetricMeta[] = [
  {
    key: 'currentQps',
    title: '当前 QPS',
    icon: 'ant-design:dashboard-outlined',
    color: DASH_COLORS.pipeline,
    tip: 'GET /pipelines/:id/status → currentQps，3 秒轮询的瞬时捕获速率（事件/秒）',
  },
  {
    key: 'lagMs',
    title: '同步延迟',
    icon: 'ant-design:field-time-outlined',
    color: DASH_COLORS.warning,
    tip: 'GET /pipelines/:id/status → lagMs，超过 5000ms 标红（与告警规则同阈值）',
  },
  {
    key: 'changeRows',
    title: '累计变更行数',
    icon: 'ant-design:number-outlined',
    color: DASH_COLORS.running,
    tip: 'GET /pipelines/:id/status → changeRows，本实例启动以来捕获的变更总数',
  },
  {
    key: 'cdcPosition',
    title: 'CDC 位点（SCN）',
    icon: 'ant-design:aim-outlined',
    color: DASH_COLORS.service,
    tip: 'GET /pipelines/:id/status → cdcPosition，源库日志位点；停止后不再推进',
  },
]

/** 指标值缺失（接口未返回 / 管道已停止）统一显示 '-'，不显示 0 以免误读 */
export function formatMetric(value?: number | string | null, digits = 0) {
  if (value === undefined || value === null || value === '') return '-'
  if (typeof value === 'string') return value.trim() || '-'
  if (Number.isNaN(Number(value))) return '-'
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/* ------------------------------------------------------------------ */
/* 服务监控页：数据服务调用明细（契约 1.9 GET /data-apis/calls）          */
/* ------------------------------------------------------------------ */

/** 调用明细结果筛选值：'all' 只在前端表达「不过滤」，请求时会剔除 */
export type ApiCallResultFilter = 'all' | 'success' | 'error'

/** Tab 与 result 查询参数一一对应 */
export const API_CALL_RESULT_TABS: { key: ApiCallResultFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'success', label: '成功' },
  { key: 'error', label: '错误' },
]

/** 调用明细表列（时间/服务/路径/HTTP/bizCode/延迟/IP/query 摘要/错误信息） */
export const apiCallColumns: TableColumn[] = [
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 175 },
  { title: '服务', dataIndex: 'apiName', key: 'apiName', width: 160, ellipsis: true },
  { title: '路径', dataIndex: 'path', key: 'path', width: 170, ellipsis: true },
  { title: 'HTTP', dataIndex: 'httpStatus', key: 'httpStatus', width: 80, align: 'center' },
  { title: 'bizCode', dataIndex: 'bizCode', key: 'bizCode', width: 95, align: 'center' },
  { title: '延迟', dataIndex: 'latencyMs', key: 'latencyMs', width: 95, align: 'right' },
  { title: '来源 IP', dataIndex: 'ip', key: 'ip', width: 135 },
  { title: 'query 摘要', dataIndex: 'query', key: 'query', width: 240, ellipsis: true },
  { title: '错误信息', dataIndex: 'errorMsg', key: 'errorMsg', width: 260, ellipsis: true },
]

/** 管道实例日志列（GET /task-instances/:id/logs 的 TaskLog） */
export const pipelineLogColumns: TableColumn[] = [
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 175 },
  { title: '级别', dataIndex: 'level', key: 'level', width: 90 },
  { title: '日志内容', dataIndex: 'message', key: 'message', ellipsis: true },
]

/**
 * 调用是否失败：以契约的 ok 字段为准，
 * 后端未给 ok 时按 bizCode != 0 或 httpStatus >= 400 兜底判定。
 */
export function isCallFailed(row: DataApiCallItem) {
  if (typeof row?.ok === 'boolean') return !row.ok
  const bizCode = Number(row?.bizCode ?? 0)
  if (row?.bizCode !== undefined && row?.bizCode !== null && !Number.isNaN(bizCode)) {
    return bizCode !== 0
  }
  const status = Number(row?.httpStatus ?? 200)
  return !Number.isNaN(status) && status >= 400
}

/* ------------------------------------------------------------------ */
/* 总览页导航卡：三个大屏页的入口与一句话说明                             */
/* ------------------------------------------------------------------ */

export interface MonitorPageMeta {
  path: string
  title: string
  icon: string
  color: string
  desc: string
}

export const MONITOR_PAGES: MonitorPageMeta[] = [
  {
    path: '/monitor/running',
    title: '运行监控',
    icon: 'ant-design:rocket-outlined',
    color: DASH_COLORS.running,
    desc: '运行中实例表 + 进度采样曲线 + 实时日志流',
  },
  {
    path: '/monitor/pipeline',
    title: '管道监控',
    icon: 'ant-design:pulse-outlined',
    color: DASH_COLORS.pipeline,
    desc: '单管道 QPS / 延迟 / 变更行数 / SCN 位点实时指标与实例日志',
  },
  {
    path: '/monitor/dataapi',
    title: '服务监控',
    icon: 'ant-design:api-outlined',
    color: DASH_COLORS.service,
    desc: '调用量与错误率看板 + 7 日成功/错误趋势 + 调用明细',
  },
]
