import type { DatabridgePageParams } from './commonModel'

/** 数据服务状态（契约 0 枚举 dataApi.status） */
export type DataApiStatus = 'draft' | 'published'

/** 对外暴露的 HTTP 方法：运行时端点为 GET /ds/{path}，POST 用于参数放 body 的场景 */
export type DataApiMethod = 'GET' | 'POST'

/** 输出字段类型：builder 模式从 meta/columns 自动带出真实数据库类型（NUMBER / VARCHAR2 等），契约示例枚举仅作提示 */
export type DataApiFieldType = 'BIGINT' | 'DECIMAL' | 'VARCHAR' | 'DATE' | 'BOOLEAN' | (string & {})

/** 查询参数类型（契约 1.9.2 queryParams[].type）：list 调用时传逗号分隔字符串 */
export type DataApiQueryType = 'string' | 'number' | 'date' | 'list'

/** SQL 配置模式（契约 1.9.2/1.9.3）：builder 拼 SELECT，custom 执行 customSql，forward API 转发 */
export type DataApiSqlMode = 'builder' | 'custom' | 'forward'

/** 1.9.3 转发固定请求头（值支持 :name 占位符；调用方 header 不下传） */
export interface DataApiForwardHeader {
  name: string
  value: string
}

/** GET /data-apis/meta/tables 返回单项（契约 1.9.1） */
export interface MetaTable {
  name: string
  comment?: string | null
}

/** GET /data-apis/meta/columns 返回单项（契约 1.9.1） */
export interface MetaColumn {
  name: string
  /** 数据库真实类型（NUMBER / VARCHAR2 / DATE 等），builder 模式勾中后原样带入 fields[].type */
  type: string
  nullable?: boolean
  comment?: string | null
}

/** GET /data-apis/meta/tables 请求参数（契约 1.9.1） */
export interface DataApiMetaTablesParams {
  datasourceId: string
  keyword?: string
}

/** GET /data-apis/meta/columns 请求参数（契约 1.9.1） */
export interface DataApiMetaColumnsParams {
  datasourceId: string
  tableName: string
}

export interface DataApiField {
  name: string
  type: DataApiFieldType
}

export interface DataApiQueryParam {
  name: string
  type: DataApiQueryType
  required?: boolean
  /** 1.9.4：参数说明（文档模板 paramDocs 的默认来源） */
  remark?: string
}

/** 1.9.4 文档配置（apiDoc）：创建/更新时为空由后端自动生成模板，admin 可在界面修改 */
export interface ApiDoc {
  summary?: string
  description?: string
  /** 参数名 -> 说明（swagger 参数表格的 description 来源） */
  paramDocs?: Record<string, string>
  /** builder/custom：{fields, rows, total, page, size}；forward：{note:'透传下游响应'} 或下游样例 */
  responseExample?: Recordable | null
}

/** GET /data-apis/swagger.json 查询参数（契约 1.9.4，status=all 仅 admin） */
export interface SwaggerDocParams {
  status?: 'published' | 'all'
  keyword?: string
}

/** OpenAPI 3.0 单项参数（只声明文档中心用到的键） */
export interface SwaggerParameter {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: Recordable
  example?: any
}

/** OpenAPI operation（含 x-databridge 扩展） */
export interface SwaggerOperation {
  tags?: string[]
  summary?: string
  description?: string
  operationId?: string
  parameters?: SwaggerParameter[]
  responses?: Record<string, any>
  security?: Record<string, any>[]
  'x-databridge'?: {
    apiId?: string
    apiName?: string
    datasourceId?: string | null
    sqlMode?: DataApiSqlMode
    status?: DataApiStatus
    authEnabled?: boolean
    rateLimitQps?: number | null
  }
}

/** OpenAPI spec 顶层（契约 1.9.4，响应为 spec 本体、不套统一信封） */
export interface SwaggerSpec {
  openapi?: string
  info?: { title?: string; version?: string; description?: string }
  tags?: { name: string; description?: string }[]
  paths?: Record<string, Record<string, SwaggerOperation>>
  components?: Recordable
}

export interface DataApi {
  id?: string
  name: string
  /** 运行时路径片段：GET /ds/{path} */
  path: string
  method?: DataApiMethod
  datasourceId: string
  tableName: string
  /** SQL 配置模式（契约 1.9.2），缺省视为 builder */
  sqlMode?: DataApiSqlMode
  /** custom 模式执行的 SQL；:name 占位符与 queryParams 按名绑定，仅允许只读语句 */
  customSql?: string | null
  /** 1.9.3 forward 模式字段（sqlMode=forward 时生效，datasourceId/tableName 可空） */
  forwardUrl?: string | null
  forwardMethod?: 'GET' | 'POST'
  forwardHeaders?: DataApiForwardHeader[]
  forwardBodyTemplate?: string | null
  forwardTimeoutMs?: number
  forwardPassthroughQuery?: boolean
  fields: DataApiField[]
  queryParams?: DataApiQueryParam[]
  authEnabled?: boolean
  /**
   * 发布后生成。注意：Mock 阶段的管理端列表 / 详情不做脱敏（内存数据 + 无鉴权），
   * 因此这里的值与 GET /data-apis/:id/publish 返回的是同一个 key；
   * 第二阶段接鉴权后应在管理端列表里脱敏，只保留发布响应返回明文。
   */
  apiKey?: string | null
  rateLimitQps?: number
  /** 精确 IP 或 * 前缀（如 10.0.0.*）列表，空数组表示不限制；不支持 CIDR */
  ipWhitelist?: string[]
  status?: DataApiStatus
  /** 1.9.4 文档配置（后端在创建/更新为空时自动生成模板） */
  apiDoc?: ApiDoc | null
  invokeCount?: number
  errorCount?: number
  avgLatencyMs?: number
  createdAt?: string | null
  updatedAt?: string | null
  /** 数据源名称，列表页用 /datasources 聚合展示 */
  datasourceName?: string
}

/** 创建 / 编辑数据服务的请求体（契约 1.9，invokeCount 等统计字段不回传） */
export interface DataApiPayload {
  name: string
  path: string
  method: DataApiMethod
  datasourceId: string
  tableName: string
  /** SQL 配置模式（契约 1.9.2），不传时后端按 builder 处理 */
  sqlMode?: DataApiSqlMode
  /** 仅 custom 模式提交；builder 模式省略该键 */
  customSql?: string | null
  /** 1.9.3 forward 模式字段（sqlMode=forward 时必填 forwardUrl，其余可缺省） */
  forwardUrl?: string | null
  forwardMethod?: 'GET' | 'POST'
  forwardHeaders?: DataApiForwardHeader[]
  forwardBodyTemplate?: string | null
  forwardTimeoutMs?: number
  forwardPassthroughQuery?: boolean
  fields: DataApiField[]
  queryParams: DataApiQueryParam[]
  authEnabled: boolean
  rateLimitQps: number
  ipWhitelist: string[]
  /** 1.9.4 文档配置；不传/传空由后端生成模板（编辑时传空不会覆盖已保存内容） */
  apiDoc?: ApiDoc | null
}

export interface DataApiPageParams extends DatabridgePageParams {
  status?: DataApiStatus
  datasourceId?: string
}

/** 调用明细结果筛选（契约 1.9 GET /data-apis/calls?result=） */
export type DataApiCallResult = 'success' | 'error'

/**
 * 调用明细日志单项（契约 1.9 GET /data-apis/calls 的 items[]）。
 * 后端滚动保留最近 5000 条，query 中的 apiKey 已脱敏。
 */
export interface DataApiCallItem {
  id: string
  apiId: string
  apiName?: string | null
  /** 运行时路径片段，对应 GET /ds/{path} */
  path?: string | null
  method?: DataApiMethod | string | null
  /** 运行时 HTTP 状态码（200/401/403/429/404/502…） */
  httpStatus?: number | string | null
  /** 业务码：0 成功，其余为契约 1.9 定义的错误码（40101/42901/50003 等） */
  bizCode?: number | string | null
  ok?: boolean | null
  latencyMs?: number | null
  ip?: string | null
  /** 请求 query 摘要（apiKey 已脱敏） */
  query?: string | null
  errorMsg?: string | null
  createdAt?: string | null
}

/** GET /data-apis/calls 请求参数（契约 1.9，审计日志查询页） */
export interface DataApiCallPageParams extends DatabridgePageParams {
  apiId?: string
  result?: DataApiCallResult
  /** 服务名/路径模糊 */
  apiName?: string
  /** 调用内容模糊：脱敏 query 或错误信息 */
  content?: string
  /** ISO 时间闭区间 */
  startTime?: string
  endTime?: string
}

/**
 * POST /data-apis/:id/publish 返回：契约只保证状态变为 published，
 * 完整 apiKey 仅此次返回，前端一次性弹窗展示
 */
export interface DataApiPublishResult {
  id?: string
  status?: DataApiStatus
  apiKey?: string
  path?: string
  method?: DataApiMethod
}

/**
 * POST /data-apis/:id/invoke 请求体（管理端代理转发到运行时 /ds/{path}）。
 * 自定义查询参数用 queryParams 键，后端 controllers/dataapi.controller.js 里与 query 等价。
 */
export interface DataApiInvokeParams {
  page?: number
  size?: number
  queryParams?: Recordable
  /** 调试代理透传的 X-API-Key（空串=模拟未带 Key 触发 40101） */
  apiKey?: string
}

/** 运行时 result 数据结构（契约 1.9 成功响应） */
export interface DataApiInvokeData {
  fields?: string[]
  rows?: any[][]
  total?: number
  page?: number
  size?: number
}

/** 运行时信封（契约 0 节），管理端代理把它整体放在 body 里透传 */
export interface DataApiInvokeEnvelope {
  httpStatus?: number
  code?: number
  message?: string
  result?: DataApiInvokeData
  timestamp?: number
}

/**
 * 调试调用返回：后端（POST /data-apis/:id/invoke）把运行时结果包成
 * { httpStatus, body: 运行时信封 }，也只透传 result 的实现做兼容，
 * 因此页面统一用 normalizeInvokeResult 归一。
 */
export interface DataApiInvokeResult extends DataApiInvokeData {
  httpStatus?: number
  code?: number
  message?: string
  result?: DataApiInvokeData
  body?: DataApiInvokeEnvelope
}

/** GET /data-apis/:id/stats 的 recentTrend 单项；后端字段名未细化，多键兼容 */
export interface DataApiTrendItem {
  date: string
  count?: number
  invokeCount?: number
  success?: number
  failed?: number
  errorCount?: number
  avgLatencyMs?: number
}

export interface DataApiStats {
  apiId?: string
  id?: string
  name?: string
  invokeCount: number
  errorCount: number
  avgLatencyMs: number
  recentTrend?: DataApiTrendItem[]
}
