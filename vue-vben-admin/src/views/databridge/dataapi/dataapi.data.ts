import type { SelectOption, TableColumn } from '../data'
import type {
  DataApiField,
  DataApiInvokeData,
  DataApiInvokeResult,
  DataApiQueryParam,
  DataApiSqlMode,
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

/* ------------------------------------------------------------------ */
/* 契约 1.9.1 / 1.9.2：SQL 模式、元数据勾选、自定义 SQL 前端预检       */
/* ------------------------------------------------------------------ */

/** SQL 模式单选（契约 1.9.2 sqlMode） */
export const DATAAPI_SQL_MODE_OPTIONS: SelectOption[] = [
  { label: '构建模式', value: 'builder' },
  { label: '自定义 SQL', value: 'custom' },
  { label: 'API 转发', value: 'forward' },
]

export const DATAAPI_SQL_MODE_LABELS: Record<DataApiSqlMode, string> = {
  builder: '构建模式',
  custom: '自定义 SQL',
  forward: 'API 转发',
}

export function getSqlModeLabel(mode?: DataApiSqlMode) {
  return DATAAPI_SQL_MODE_LABELS[mode ?? 'builder']
}

/** 列表页「输出字段」列对 custom 模式的 Tag 配色 */
export function getSqlModeColor(mode?: DataApiSqlMode) {
  if (mode === 'custom') return 'geekblue'
  if (mode === 'forward') return 'purple'
  return 'default'
}

/** 查询参数类型下拉（契约 1.9.2：string|number|date|list，list 调用时传逗号分隔） */
export const DATAAPI_QUERY_PARAM_TYPE_OPTIONS: SelectOption[] = [
  { label: 'string 字符串', value: 'string' },
  { label: 'number 数值', value: 'number' },
  { label: 'date 日期时间', value: 'date' },
  { label: 'list 列表（逗号分隔）', value: 'list' },
]

/** builder 模式「字段勾选」表格列：数据源为 GET /data-apis/meta/columns（契约 1.9.1） */
export const metaColumnTableColumns: TableColumn[] = [
  { title: '字段名', dataIndex: 'name', key: 'name', width: 170, ellipsis: true },
  { title: '类型', dataIndex: 'type', key: 'type', width: 120, ellipsis: true },
  { title: '可空', dataIndex: 'nullable', key: 'nullable', width: 64, align: 'center' },
  { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true },
]

/**
 * 去掉字符串字面量与注释，口径尽量对齐后端「规范化后校验」：
 * 前端检查只是第一道 UX 防线，后端仍是权威（契约 1.9.2 安全红线）。
 */
function stripSqlLiterals(sql: string) {
  return String(sql ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'[^']*'/g, ' ')
}

/** 提取 SQL 里的 :name 占位符集合（去重、保留首次出现顺序；忽略字符串字面量内的冒号，如 TO_DATE 格式串） */
export function extractSqlPlaceholders(sql?: string | null): string[] {
  const text = stripSqlLiterals(String(sql ?? ''))
  const names: string[] = []
  const pattern = /:([A-Za-z_][A-Za-z0-9_]*)/g
  let match = pattern.exec(text)
  while (match) {
    if (!names.includes(match[1])) names.push(match[1])
    match = pattern.exec(text)
  }
  return names
}

/** 黑名单与后端 controllers 保持同一词表（词边界匹配，UNION 允许） */
const SQL_BANNED_KEYWORD_PATTERN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|EXECUTE|CALL|BEGIN|LOCK|RENAME)\b/i

/**
 * customSql 只读预检（契约 1.9.2 安全红线 1、2 的前端镜像）：
 * - 必填；去尾分号后不得再含 ;（禁止多语句）
 * - 必须以 SELECT 或 WITH 开头
 * - 写操作/DDL 关键字黑名单
 * @returns 通过返回空字符串，否则返回可直接展示的红色文案
 */
export function checkCustomSql(sql?: string | null): string {
  const raw = String(sql ?? '').trim()
  if (!raw) return '请填写自定义 SQL'
  const normalized = stripSqlLiterals(raw).trim().replace(/;+$/, '').trim()
  if (!normalized) return '请填写自定义 SQL'
  if (normalized.includes(';')) return '自定义 SQL 仅允许单条语句（检测到中段分号）'
  if (!/^(SELECT|WITH)\b/i.test(normalized)) return '自定义 SQL 必须以 SELECT 或 WITH 开头（仅允许只读查询）'
  const banned = normalized.match(SQL_BANNED_KEYWORD_PATTERN)
  if (banned) {
    return `自定义 SQL 含禁用关键字 ${String(banned[1]).toUpperCase()}，仅允许只读查询（UNION 不受限）`
  }
  return ''
}

/**
 * 占位符与查询参数声明的差集：
 * missing = SQL 引用但未声明（契约要求占位符集合 ⊆ queryParams，后端 40001）；
 * unused = 已声明但 SQL 未引用（仅提示，不阻止提交）。
 */
export function diffSqlPlaceholders(
  placeholders: string[],
  declaredNames: string[],
): { missing: string[]; unused: string[] } {
  const declaredSet = new Set(declaredNames)
  const placeholderSet = new Set(placeholders)
  return {
    missing: placeholders.filter((name) => !declaredSet.has(name)),
    unused: declaredNames.filter((name) => !placeholderSet.has(name)),
  }
}

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
  /** 响应原始 body（1.9.3 forward 透传的下游 JSON 靠它展示，表格视图取不到 fields/rows 时兜底） */
  raw: Recordable
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
    raw: inner,
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

/* ------------------------------------------------------------------ */
/* curl 命令解析（API 转发配置快速导入，契约 1.9.3 的录入辅助）          */
/* ------------------------------------------------------------------ */

export interface ParsedCurl {
  url: string
  method: string
  headers: { name: string; value: string }[]
  body: string | null
  /** 未能识别/被忽略的部分，展示给用户自查 */
  warnings: string[]
}

/** shell 风格分词：单引号原样、双引号内保留空格并支持反斜杠转义、行尾 \ 续行 */
function tokenizeCommand(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ')
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let has = false
  const push = () => {
    if (has) tokens.push(current)
    current = ''
    has = false
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'") inSingle = false
      else current += ch
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === '\\' && ['"', '\\', '$', '`'].includes(text[i + 1])) {
        current += text[i + 1]
        i += 1
      } else current += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      has = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      has = true
      continue
    }
    if (ch === '\\' && text[i + 1]) {
      current += text[i + 1]
      has = true
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    current += ch
    has = true
  }
  push()
  return tokens
}

/** 需要跟一个值的 curl 选项 */
const VALUE_FLAGS: Record<string, string> = {
  '-X': 'method',
  '--request': 'method',
  '-H': 'header',
  '--header': 'header',
  '-d': 'data',
  '--data': 'data',
  '--data-raw': 'data',
  '--data-binary': 'data',
  '--data-urlencode': 'data',
  '-u': 'user',
  '--user': 'user',
  '-b': 'cookie',
  '--cookie': 'cookie',
  '--url': 'url',
  '--connect-timeout': 'ignore',
  '--max-time': 'ignore',
  '-o': 'ignore',
  '--output': 'ignore',
  '-A': 'ignore',
  '--user-agent': 'ignore',
  '-e': 'ignore',
  '--referer': 'ignore',
}

/** 纯开关型 curl 选项（解析时安全忽略） */
const BOOLEAN_FLAGS = new Set([
  '-s', '-S', '-L', '-k', '-v', '-i', '-G', '-I', '-f', '-N', '-J', '-O',
  '--compressed', '--insecure', '--location', '--silent', '--show-error', '--verbose',
  '--head', '--get', '--fail', '--no-buffer', '--http2', '--http1.1', '--tls-max',
])

/**
 * 解析一段 curl 命令 → 转发配置（url/method/headers/body）。
 * 覆盖常见写法：-X、-H（多个）、-d/--data*（多个以 & 拼接）、-u（转 Basic 头）、-b（转 Cookie 头）；
 * 无法识别的选项跳过并记入 warnings，绝不静默吞掉。
 */
export function parseCurlCommand(input: string): ParsedCurl {
  const tokens = tokenizeCommand(String(input || '').trim())
  const result: ParsedCurl = { url: '', method: '', headers: [], body: null, warnings: [] }
  const dataParts: string[] = []
  let i = tokens[0]?.toLowerCase().startsWith('curl') ? 1 : 0
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith('-') && token !== '-') {
      const flagKey = token.split('=')[0]
      const inlineValue = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined
      const kind = VALUE_FLAGS[flagKey]
      if (kind) {
        const value = inlineValue ?? tokens[++i] ?? ''
        switch (kind) {
          case 'method':
            result.method = value.toUpperCase()
            break
          case 'header': {
            const sep = value.indexOf(':')
            if (sep > 0) {
              result.headers.push({ name: value.slice(0, sep).trim(), value: value.slice(sep + 1).trim() })
            } else {
              result.warnings.push(`忽略不合法的 -H：${value}`)
            }
            break
          }
          case 'data':
            dataParts.push(value)
            break
          case 'user':
            result.headers.push({
              name: 'Authorization',
              value: `Basic ${btoa(value.replace(/"/g, ''))}`,
            })
            break
          case 'cookie':
            result.headers.push({ name: 'Cookie', value })
            break
          case 'url':
            result.url = value
            break
          default:
            break
        }
        continue
      }
      if (BOOLEAN_FLAGS.has(flagKey)) continue
      result.warnings.push(`未识别的选项：${token}（已跳过）`)
      continue
    }
    if (!result.url && /^(https?):\/\//i.test(token)) {
      result.url = token.replace(/^["']|["']$/g, '')
      continue
    }
    result.warnings.push(`忽略多余片段：${token}`)
  }
  if (!result.url) result.warnings.unshift('未解析到 http(s) 地址')
  if (dataParts.length) result.body = dataParts.join('&')
  if (!result.method) result.method = result.body ? 'POST' : 'GET'
  return result
}
