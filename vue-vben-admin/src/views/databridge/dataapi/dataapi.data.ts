import type { TableColumn } from '../data'
import type {
  DataApiField,
  DataApiInvokeData,
  DataApiInvokeResult,
  DataApiQueryParam,
  DataApiTrendItem,
} from '/@/api/databridge/model/dataapiModel'

/** path 只允许小写字母、数字与连字符，避免拼 URL 时出现转义问题 */
export const DATAAPI_PATH_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 运行时基地址：dev 环境 vite 未代理 /ds，直接给出管理后端端口 */
export const DATA_RUNTIME_BASE = import.meta.env.DEV
  ? 'http://127.0.0.1:3001'
  : window.location.origin

export const DATAAPI_RUNTIME_PREFIX = '/ds'

/** path 输入实时建议（把中文/大写/空格转成合法 slug） */
export function suggestApiPath(value: string) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function getRuntimeUrl(path: string, baseUrl = DATA_RUNTIME_BASE) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return `${base}${DATAAPI_RUNTIME_PREFIX}/${String(path ?? '').replace(/^\/+/, '')}`
}

/** 列表页「运行时路径」列文案 */
export function getRuntimePathText(api: { method?: string; path?: string }) {
  return `${api.method || 'GET'} ${DATAAPI_RUNTIME_PREFIX}/${api.path || '-'}`
}

export function getFieldsSummary(fields?: DataApiField[]) {
  const list = fields ?? []
  if (!list.length) return '-'
  const text = list.map((item) => `${item.name}:${item.type}`).join('、')
  return list.length > 4 ? `${list.slice(0, 4).map((i) => i.name).join('、')} 等 ${list.length} 个字段` : text
}

export function getQueryParamSummary(params?: DataApiQueryParam[]) {
  const list = params ?? []
  if (!list.length) return '无'
  return list.map((item) => `${item.name}${item.required ? '*' : ''}:${item.type}`).join('、')
}

/** 列表/详情共用：字段行编辑表格列 */
export const fieldTableColumns: TableColumn[] = [
  { title: '字段名', key: 'name', width: 180 },
  { title: '字段类型', key: 'type', width: 160 },
  { title: '操作', key: 'action', width: 70, align: 'center' },
]

/** 数据服务列表列定义（契约 1.9） */
export const dataApiColumns: TableColumn[] = [
  { title: 'ID', dataIndex: 'id', key: 'id', width: 110 },
  { title: '服务名称', dataIndex: 'name', key: 'name', width: 160, ellipsis: true },
  { title: '运行时路径', key: 'path', width: 200, ellipsis: true },
  { title: '数据源 / 表', key: 'datasource', width: 200, ellipsis: true },
  { title: '输出字段', key: 'fields', width: 200, ellipsis: true },
  { title: '查询参数', key: 'queryParams', width: 190, ellipsis: true },
  { title: '鉴权', key: 'authEnabled', width: 90, align: 'center' },
  { title: '限流 QPS', dataIndex: 'rateLimitQps', key: 'rateLimitQps', width: 100, align: 'right' },
  { title: '状态', dataIndex: 'status', key: 'status', width: 90 },
  { title: '调用次数', dataIndex: 'invokeCount', key: 'invokeCount', width: 110, align: 'right' },
  { title: '错误 / 平均延迟', key: 'errorLatency', width: 150 },
  { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 170 },
  { title: '操作', key: 'action', width: 300 },
]

/** 查询参数行编辑表格列 */
export const queryParamTableColumns: TableColumn[] = [
  { title: '参数名', key: 'name', width: 160 },
  { title: '类型', key: 'type', width: 140 },
  { title: '必填', key: 'required', width: 70, align: 'center' },
  { title: '操作', key: 'action', width: 70, align: 'center' },
]

/**
 * 归一化 POST /data-apis/:id/invoke 的返回：
 * 后端（controllers/dataapi.controller.js）把运行时结果整体包成 { httpStatus, body }，
 * body 才是契约 0 节的信封 { code, message, result }；
 * 也存在只透传运行时 result 的实现，因此三层形状（body → 信封 → result）都在这里剥掉。
 */
export function normalizeInvokeResult(res?: DataApiInvokeResult | null): {
  httpStatus: number
  code?: number
  message?: string
  data: DataApiInvokeData
} {
  const payload = res ?? {}
  const envelope = payload as Recordable
  // 管理端代理：先看 body，再退版本身就是信封的情况
  const inner: Recordable =
    envelope.body && typeof envelope.body === 'object' ? envelope.body : envelope
  const data: DataApiInvokeData = inner.result ?? inner
  const code = Number(inner.code ?? 0) || undefined
  // 运行时 HTTP 状态码可能来自代理包装层（httpStatus），也可能内层带 status
  const rawStatus = Number(envelope.httpStatus ?? inner.httpStatus ?? inner.status ?? 0)
  return {
    httpStatus: rawStatus > 0 ? rawStatus : code ? 400 : 200,
    code,
    message: inner.message,
    data: {
      fields: data?.fields ?? [],
      rows: data?.rows ?? [],
      total: data?.total ?? 0,
      page: data?.page,
      size: data?.size,
    },
  }
}

/** rows 二维数组 → ant Table 的行对象 */
export function toInvokeTableData(fields?: string[], rows?: any[][]) {
  const columns = fields ?? []
  return (rows ?? []).map((row, index) => {
    const record: Recordable = { __rowKey: index }
    columns.forEach((field, fieldIndex) => {
      record[field] = row?.[fieldIndex]
    })
    return record
  })
}

/** recentTrend 单项取调用次数：后端字段名未细化，按优先级兜底 */
export function getTrendCount(item: DataApiTrendItem) {
  const success = Number(item?.success ?? 0)
  const failed = Number(item?.failed ?? item?.errorCount ?? 0)
  if (item?.count !== undefined) return Number(item.count)
  if (item?.invokeCount !== undefined) return Number(item.invokeCount)
  return success + failed
}

export function getTrendErrorCount(item: DataApiTrendItem) {
  if (item?.errorCount !== undefined) return Number(item.errorCount)
  return Number(item?.failed ?? 0)
}

export interface CurlBuildOptions {
  baseUrl: string
  path: string
  method?: string
  page: number
  size: number
  queryParams?: Recordable
  apiKey?: string
  authEnabled?: boolean
}

/** 生成可直接粘贴到终端的 curl 命令串（含 X-API-Key 占位与 /ds/{path} URL） */
export function buildCurlCommand(options: CurlBuildOptions): string {
  const params: Recordable = { page: options.page, size: options.size, ...(options.queryParams ?? {}) }
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&')
  const url = `${getRuntimeUrl(options.path, options.baseUrl)}${query ? `?${query}` : ''}`
  const method = (options.method || 'GET').toUpperCase()
  const key = String(options.apiKey ?? '').trim() || '<YOUR_API_KEY>'
  const lines = [`curl -X ${method} "${url}"`]
  if (options.authEnabled !== false) lines.push(`  -H "X-API-Key: ${key}"`)
  return lines.join(' \\\n')
}
