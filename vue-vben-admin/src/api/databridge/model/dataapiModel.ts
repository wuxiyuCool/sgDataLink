import type { DatabridgePageParams } from './commonModel'

/** 数据服务状态（契约 0 枚举 dataApi.status） */
export type DataApiStatus = 'draft' | 'published'

/** 对外暴露的 HTTP 方法：运行时端点为 GET /ds/{path}，POST 用于参数放 body 的场景 */
export type DataApiMethod = 'GET' | 'POST'

/** 输出字段类型：builder 模式从 meta/columns 自动带出真实数据库类型（NUMBER / VARCHAR2 等），契约示例枚举仅作提示 */
export type DataApiFieldType = 'BIGINT' | 'DECIMAL' | 'VARCHAR' | 'DATE' | 'BOOLEAN' | (string & {})

/** 查询参数类型（契约 1.9.2 queryParams[].type）：list 调用时传逗号分隔字符串 */
export type DataApiQueryType = 'string' | 'number' | 'date' | 'list'

/** SQL 配置模式（契约 1.9.2 sqlMode）：builder 按 tableName+fields 拼 SELECT，custom 执行 customSql */
export type DataApiSqlMode = 'builder' | 'custom'

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
  fields: DataApiField[]
  queryParams: DataApiQueryParam[]
  authEnabled: boolean
  rateLimitQps: number
  ipWhitelist: string[]
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

/** GET /data-apis/calls 请求参数（契约 1.9） */
export interface DataApiCallPageParams extends DatabridgePageParams {
  apiId?: string
  result?: DataApiCallResult
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
