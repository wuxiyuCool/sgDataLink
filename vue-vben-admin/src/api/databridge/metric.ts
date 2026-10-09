import { databridgeHttp } from './http'

/**
 * 指标中心接口（契约 1.12）。当前页面按里程碑逐步接入，本文件先覆盖系统配置。
 */

/** 单项配置的生效值（value 对 secret 项只回掩码 sk-xx***） */
export interface MetricSettingItem {
  settingKey: string
  source: 'table' | 'env' | 'default'
  hasValue: boolean
  value: string | null
}

export interface MetricSettingsResult {
  items: MetricSettingItem[]
}

/** PUT 为嵌套形态（全局 mongo-sanitize 拆点分键，契约 1.12 定案） */
export interface MetricSettingsPayload {
  settings: {
    llm: {
      baseUrl?: string
      model?: string
      apiKey?: string
      timeoutMs?: string
      embedModel?: string
      embed?: { enabled?: string; baseUrl?: string; apiKey?: string }
    }
    /** 契约 1.14：维度候选值是否进问数 prompt（默认关，真实数据出境需显式开） */
    chat?: { dimValuePrompt?: string; dimValueTopN?: string }
  }
}

export function getMetricSettingsApi() {
  return databridgeHttp.get<MetricSettingsResult>({ url: '/metric-settings' })
}

export function updateMetricSettingsApi(data: MetricSettingsPayload) {
  return databridgeHttp.put<{ updated: string[] }>({ url: '/metric-settings', data })
}

// ==================== 首页概览 ====================

export interface MetricDashboard {
  domains: { total: number }
  models: { total: number; byLayer: Record<string, number> }
  metrics: { total: number; byType: Record<string, number>; byStatus: Record<string, number> }
  tasks: {
    total: number
    enabled: number
    last24h: { success: number; failed: number; running: number }
    successRate: number
  }
  chat: { last7dQueries: number; last7dFailed: number }
  hotMetrics: { id: string; name: string; count: number }[]
}

export function getMetricDashboardApi() {
  return databridgeHttp.get<MetricDashboard>({ url: '/metric-dashboard' })
}

// ==================== 指标域 ====================

export interface MetricDomain {
  id: string
  code: string
  name: string
  parentId?: string
  tablePrefix?: string
  owner?: string
  remark?: string
  sort?: number
  status?: string
  modelCount?: number
  metricCount?: number
  children?: MetricDomain[]
}

export function getMetricDomainsApi(params?: { keyword?: string }) {
  return databridgeHttp.get<{ items: MetricDomain[] }>({ url: '/metric-domains', params })
}

export function getMetricDomainTreeApi() {
  return databridgeHttp.get<{ items: MetricDomain[] }>({ url: '/metric-domains/tree' })
}

export function createMetricDomainApi(data: Partial<MetricDomain>) {
  return databridgeHttp.post<MetricDomain>({ url: '/metric-domains', data })
}

export function updateMetricDomainApi(id: string, data: Partial<MetricDomain>) {
  return databridgeHttp.put<MetricDomain>({ url: `/metric-domains/${id}`, data })
}

export function deleteMetricDomainApi(id: string) {
  return databridgeHttp.delete<{ deleted: boolean }>({ url: `/metric-domains/${id}` })
}

// ==================== 数据建模 ====================

export interface MetricModelColumn {
  columnName: string
  bizName?: string
  dataType?: string
  role: 'dimension' | 'time' | 'measure'
  aggDefault?: string
  isKey?: boolean
  remark?: string
}

export interface MetricModel {
  id: string
  name: string
  datasourceId: string
  domainId: string
  layer: string
  tableName: string
  createType: 'reference' | 'ddl'
  timeColumn?: string
  tableDdl?: string | null
  /** draft | online | offline：草稿可反复改字段，但不能建表、不能被指标/任务引用 */
  status?: string
  /** none | created | exists | failed：平台对物理表的留痕（reference 恒为 exists） */
  tableStatus?: string
  /** 建表失败时后端存原始报错（ORA-/1146），界面直接展示用于排障 */
  tableMsg?: string
  tableAt?: string | null
  remark?: string
  columns?: MetricModelColumn[]
  warnings?: string[]
}

export interface MetricModelPageParams {
  domainId?: string
  layer?: string
  datasourceId?: string
  status?: string
  keyword?: string
  page?: number
  size?: number
}

export function getMetricModelsApi(params: MetricModelPageParams) {
  return databridgeHttp.get<{ items: MetricModel[]; total: number; page: number; size: number }>({
    url: '/metric-models',
    params,
  })
}

export function getMetricModelApi(id: string) {
  return databridgeHttp.get<MetricModel>({ url: `/metric-models/${id}` })
}

export function createMetricModelApi(data: Partial<MetricModel>) {
  return databridgeHttp.post<MetricModel>({ url: '/metric-models', data })
}

export function updateMetricModelApi(id: string, data: Partial<MetricModel>) {
  return databridgeHttp.put<MetricModel>({ url: `/metric-models/${id}`, data })
}

export function replaceMetricModelColumnsApi(id: string, columns: MetricModelColumn[]) {
  return databridgeHttp.put<MetricModel>({ url: `/metric-models/${id}/columns`, data: { columns } })
}

export interface MetricModelDeleteResult {
  id: string
  deleted: boolean
  dropped: boolean
  dropMsg?: string
}

export function deleteMetricModelApi(id: string, options?: { dropTable?: boolean }) {
  return databridgeHttp.delete<MetricModelDeleteResult>({
    url: `/metric-models/${id}`,
    params: options?.dropTable ? { dropTable: true } : undefined,
  })
}

/** 生成表结果：executed=false 表示库里已存在同名的表，本次只把状态补成 created */
export interface MetricModelTableResult {
  ddl: string
  tableStatus: string
  tableMsg: string
  tableAt: string
  executed: boolean
}

/** POST /metric-models/:id/create-table：真在目标库执行 DDL（仅「界面建表」+ 已启用；幂等） */
export function createMetricModelTableApi(id: string) {
  return databridgeHttp.post<MetricModelTableResult>({ url: `/metric-models/${id}/create-table` })
}

export function previewModelDdlApi(data: {
  domainId?: string
  layer?: string
  name?: string
  tableName?: string
  columns?: MetricModelColumn[]
  /** 目标数据源：决定 DDL 用哪家方言（mysql 反引号/ENGINE，oracle 大写/VARCHAR2/COMMENT ON） */
  datasourceId?: string
}) {
  return databridgeHttp.post<{
    tableName: string
    conflict: boolean
    dialect: string
    ddl: string
  }>({
    url: '/metric-models/preview-ddl',
    data,
  })
}

/** 字段类型族目录（后端方言层唯一来源，按方言给出真实类型名与长度上限） */
export interface ColumnTypeFamily {
  family: string
  label: string
  rendered: string
  hasLength: boolean
  hasScale: boolean
  defaultLength?: number
  defaultPrecision?: number
  defaultScale?: number
  maxLength: number
}

export function getColumnTypesApi() {
  return databridgeHttp.get<{ mysql: ColumnTypeFamily[]; oracle: ColumnTypeFamily[] }>({
    url: '/metric-models/column-types',
  })
}

export function previewModelDataApi(id: string) {
  return databridgeHttp.get<{
    executable: boolean
    sql?: string
    columns: string[] | null
    rows: any[][] | null
    error?: string
  }>({ url: `/metric-models/${id}/preview` })
}

// ==================== 维度取值档案 / 码值字典（契约 1.14） ====================

export interface DimValue {
  value: string
  label: string
  hits: number
  source: 'auto' | 'manual'
  stale: boolean
  profiledAt?: string | null
}

export interface DimValueColumn {
  columnName: string
  bizName?: string
  highCardinality?: boolean
  distinctCount?: number
  values: DimValue[]
}

export interface DimProfileResult {
  modelId: string
  dialect: string
  table: string
  topN: number
  distinctGuard: number
  profiledAt: string
  columns: DimValueColumn[]
}

/** 真查目标库取维度列候选值（仅维度列；基数超阈值只标记不取值） */
export function profileModelDimensionsApi(
  id: string,
  data?: { columns?: string[]; topN?: number; distinctGuard?: number },
) {
  return databridgeHttp.post<DimProfileResult>({
    url: `/metric-models/${id}/profile-dimensions`,
    data: data || {},
  })
}

export function getModelDimensionValuesApi(
  id: string,
  params?: { columnName?: string; keyword?: string },
) {
  return databridgeHttp.get<{
    modelId: string
    columns: { columnName: string; values: DimValue[] }[]
    total: number
  }>({ url: `/metric-models/${id}/dimension-values`, params })
}

/** 登记「库里 01 = 业务华东」；label 传空串＝取消登记 */
export function saveModelDimensionValuesApi(
  id: string,
  data: { columnName: string; values: { value: string; label: string }[] },
) {
  return databridgeHttp.put<{ modelId: string; columnName: string; values: DimValue[] }>({
    url: `/metric-models/${id}/dimension-values`,
    data,
  })
}

export function clearModelDimensionValuesApi(id: string, columnName: string) {
  return databridgeHttp.delete<{ modelId: string; columnName: string; cleared: boolean }>({
    url: `/metric-models/${id}/dimension-values`,
    params: { columnName },
  })
}

// ==================== 指标管理 ====================

export interface MetricDefineParams {
  modelId?: string
  measureColumn?: string
  agg?: string
  timeColumn?: string
  filterSql?: string
  baseMetricId?: string
  dimensions?: string[]
  timePreset?: { mode: string; days?: number } | null
  [key: string]: any
}

export interface MetricItem {
  id: string
  code: string
  name: string
  alias?: string[]
  type: 'ATOMIC' | 'DERIVED' | 'COMPOSITE'
  defineType: 'MEASURE' | 'FIELD' | 'METRIC'
  defineParams?: MetricDefineParams
  expr?: string | null
  modelId?: string
  domainId?: string
  unit?: string
  dataFormat?: string
  caliber?: string
  owner?: string
  status: 'draft' | 'online' | 'offline'
  version?: number
  createdAt?: string
  updatedAt?: string
}

export interface MetricTreeNode {
  id: string
  code: string
  name: string
  type: string
  defineType?: string
  expr?: string | null
  status?: string
  modelId?: string
  value?: any
  truncated?: boolean
  children: MetricTreeNode[]
}

export interface MetricPageParams {
  domainId?: string
  type?: string
  status?: string
  keyword?: string
  page?: number
  size?: number
}

/** 广场卡片（契约 1.14）：卡片流用的轻量视图，被引用数与近 7 天热度由服务端算好 */
export interface MetricPlazaCard {
  id: string
  code: string
  name: string
  alias: string[]
  type: 'ATOMIC' | 'DERIVED' | 'COMPOSITE'
  status: 'draft' | 'online' | 'offline'
  unit: string
  dataFormat: string
  caliber: string
  owner: string
  modelId: string
  modelName: string
  domainId: string
  domainPath: string[]
  referencedBy: number
  hot7d: number
  updatedAt?: string
}

export interface MetricPlazaSection {
  id: string
  name: string
  code: string
  path: string[]
  total: number
  items: MetricPlazaCard[]
}

export interface MetricPlazaResult {
  domains: MetricPlazaSection[]
  total: number
  truncated: boolean
  limit: number
}

export interface MetricPlazaParams {
  domainId?: string
  type?: string
  /** 缺省只回 online（广场=上架目录）；all 才出现草稿与下架 */
  status?: 'draft' | 'online' | 'offline' | 'all'
  keyword?: string
  limit?: number
}

export function getMetricPlazaApi(params: MetricPlazaParams) {
  return databridgeHttp.get<MetricPlazaResult>({ url: '/metrics/plaza', params })
}

/** 批量项是「列 → 指标」的扁平形态，服务端折算成 defineParams */
export interface MetricBatchItem {
  code: string
  name: string
  domainId: string
  modelId: string
  measureColumn: string
  agg: string
  alias?: string[]
  timeColumn?: string
  filterSql?: string
  unit?: string
  dataFormat?: string
  caliber?: string
  owner?: string
  status?: string
}

export interface MetricBatchResultItem {
  index: number
  code: string
  ok: boolean
  id?: string
  name?: string
  message?: string
}

export interface MetricBatchResult {
  results: MetricBatchResultItem[]
  created: number
  failed: number
}

/** POST /metrics/batch：部分成功也回 200，逐条结果在 results 里 */
export function createMetricsBatchApi(items: MetricBatchItem[]) {
  return databridgeHttp.post<MetricBatchResult>({ url: '/metrics/batch', data: { items } })
}

export function getMetricsApi(params: MetricPageParams) {
  return databridgeHttp.get<{ items: MetricItem[]; total: number; page: number; size: number }>({
    url: '/metrics',
    params,
  })
}

export function getMetricApi(id: string) {
  return databridgeHttp.get<MetricItem>({ url: `/metrics/${id}` })
}

export function createMetricApi(data: Partial<MetricItem>) {
  return databridgeHttp.post<MetricItem>({ url: '/metrics', data })
}

export function updateMetricApi(id: string, data: Partial<MetricItem>) {
  return databridgeHttp.put<MetricItem>({ url: `/metrics/${id}`, data })
}

export function deleteMetricApi(id: string) {
  return databridgeHttp.delete<{ deleted: boolean }>({ url: `/metrics/${id}` })
}

export function validateMetricApi(data: Partial<MetricItem>) {
  return databridgeHttp.post<{ valid: boolean; errors: string[]; warnings: string[] }>({
    url: '/metrics/validate',
    data,
  })
}

export function getMetricTreeApi(id: string) {
  return databridgeHttp.get<MetricTreeNode>({ url: `/metrics/${id}/tree` })
}

export function getMetricLineageApi(id: string) {
  return databridgeHttp.get<{
    self: string
    parents: { id: string; code: string; name: string; type: string; expr?: string | null }[]
    children: { id: string; code: string; name: string; type: string; expr?: string | null }[]
  }>({ url: `/metrics/${id}/lineage` })
}

export function previewMetricApi(
  id: string,
  data: {
    dateRange?: { start?: string; end?: string } | null
    dimensions?: string[]
    limit?: number
  },
) {
  return databridgeHttp.post<{
    sql: string
    executable: boolean
    columns: string[] | null
    rows: any[][] | null
    elapsedMs?: number | null
  }>({ url: `/metrics/${id}/preview`, data })
}

export function getMetricVersionsApi(id: string) {
  return databridgeHttp.get<{
    items: {
      id: string
      version: number
      note?: string
      updatedBy?: string
      createdAt?: string
      snapshot?: any
    }[]
  }>({ url: `/metrics/${id}/versions` })
}

export function rollbackMetricApi(id: string, version: number) {
  return databridgeHttp.post<MetricItem>({ url: `/metrics/${id}/rollback`, data: { version } })
}

// ==================== 智能问数 ====================

/** 值校正记录（契约 1.14）：LLM 写的业务名被换成库里真实值，或该值不在档案里 */
export interface ChatValueCorrection {
  column: string
  from: string
  to: string
  via: 'label' | 'value'
}

export interface ChatAskResult {
  status: 'success' | 'corrected' | 'clarify' | 'failed'
  answer: string
  value?: any
  columns?: string[]
  rows?: any[][]
  m2sql?: string
  physicalSql?: string
  metricIds?: string[]
  metricTree?: MetricTreeNode | null
  candidates?: { id: string; name: string; code: string }[]
  warnings?: string[]
  corrections?: ChatValueCorrection[]
  unmapped?: { column: string; value: string; candidates: number }[]
  modelName?: string
  error?: string
}

export function chatAskApi(data: {
  question: string
  sessionId?: string
  dateRange?: { start: string; end: string } | null
}) {
  return databridgeHttp.post<ChatAskResult>({ url: '/metric-chat/ask', data })
}

export function getChatSessionApi(sessionId: string) {
  return databridgeHttp.get<{ question: string; m2sql: string | null; status: string }[]>({
    url: `/metric-chat/sessions/${sessionId}/history`,
  })
}

export function clearChatSessionApi(sessionId: string) {
  return databridgeHttp.post<boolean>({
    url: `/metric-chat/sessions/${sessionId}/history`,
    data: {},
  })
}

// ==================== 问数审计日志 ====================

export interface MetricQueryLog {
  id: string
  userName: string
  question: string
  matched?: any
  metricIds?: string
  m2sql?: string | null
  physicalSql?: string | null
  status: string
  error?: string | null
  elapsedMs?: number
  resultPreview?: string | null
  reviewed?: boolean
  createdAt?: string
}

export function getMetricLogsApi(params: {
  keyword?: string
  status?: string
  userName?: string
  startTime?: string
  endTime?: string
  page?: number
  size?: number
}) {
  return databridgeHttp.get<{ items: MetricQueryLog[]; total: number; page: number; size: number }>(
    {
      url: '/metric-logs',
      params,
    },
  )
}

export function logToExampleApi(id: string) {
  return databridgeHttp.post<{ id: string; question: string; m2sql: string }>({
    url: `/metric-logs/${id}/to-example`,
    data: {},
  })
}

// ==================== 清洗汇总任务 ====================

export interface MetricTaskCleanRule {
  type: 'filter' | 'fill' | 'rename'
  sql?: string
  column?: string
  value?: string
  to?: string
}

export interface MetricTask {
  id: string
  name: string
  domainId?: string
  sourceModelId: string
  metricIds: string[]
  dimensionColumnIds: string[]
  cleanRules: MetricTaskCleanRule[]
  timePreset?: {
    mode: 'BETWEEN' | 'RECENT'
    start?: string
    end?: string
    unit?: string
    period?: number
  } | null
  targetDatasourceId: string
  targetModelId?: string
  targetTable: string
  writeMode: 'overwrite' | 'append' | 'upsert'
  upsertKeys?: string[]
  scheduleCron?: string
  status: 'online' | 'offline'
  lastStatus?: 'idle' | 'running' | 'success' | 'failed'
  lastRunAt?: string
  lastError?: string
  remark?: string
}

export interface MetricTaskRun {
  id: string
  taskId: string
  trigger: string
  status: string
  sqlText?: string
  readRows?: number
  writeRows?: number
  elapsedMs?: number
  message?: string
  createdAt?: string
}

export function getMetricTasksApi(params: {
  domainId?: string
  status?: string
  lastStatus?: string
  keyword?: string
  page?: number
  size?: number
}) {
  return databridgeHttp.get<{ items: MetricTask[]; total: number; page: number; size: number }>({
    url: '/metric-tasks',
    params,
  })
}

export function getMetricTaskApi(id: string) {
  return databridgeHttp.get<MetricTask>({ url: `/metric-tasks/${id}` })
}

export function createMetricTaskApi(data: Partial<MetricTask>) {
  return databridgeHttp.post<MetricTask>({ url: '/metric-tasks', data })
}

export function updateMetricTaskApi(id: string, data: Partial<MetricTask>) {
  return databridgeHttp.put<MetricTask>({ url: `/metric-tasks/${id}`, data })
}

export function deleteMetricTaskApi(id: string) {
  return databridgeHttp.delete<{ deleted: boolean }>({ url: `/metric-tasks/${id}` })
}

export function runMetricTaskApi(id: string) {
  return databridgeHttp.post<MetricTaskRun>({ url: `/metric-tasks/${id}/run`, data: {} })
}

export function getMetricTaskRunsApi(id: string, params?: { page?: number; size?: number }) {
  return databridgeHttp.get<{ items: MetricTaskRun[]; total: number }>({
    url: `/metric-tasks/${id}/runs`,
    params,
  })
}

export function previewMetricTaskApi(data: Partial<MetricTask>) {
  return databridgeHttp.post<{
    statements: string[]
    dateRange: { start: string; end: string } | null
    fromTable: string
  }>({
    url: '/metric-tasks/preview',
    data,
  })
}

/** 目标表的一列（后端按 buildPlan + 方言层给出，前端不自己推类型） */
export interface MetricTaskTargetColumn {
  name: string
  type: string
  /** 维度 | 指标 | 留痕 */
  source: string
  comment: string
}

export interface MetricTaskTargetSchema {
  dialect: string
  table: string
  /** true=执行时自动 CREATE；false=写入已有目标模型对应的表 */
  autoCreate: boolean
  writeMode: string
  primaryKeys: string[]
  columns: MetricTaskTargetColumn[]
  createSql: string | null
  insertSql: string | null
}

/** 目标表结构回显（选了哪些维度/指标会建成什么样；不落库不执行） */
export function previewMetricTaskSchemaApi(data: Partial<MetricTask>) {
  return databridgeHttp.post<MetricTaskTargetSchema>({
    url: '/metric-tasks/target-schema',
    data,
  })
}
