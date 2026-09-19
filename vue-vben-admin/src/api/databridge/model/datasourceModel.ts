import type { DatabridgePageParams, EnabledStatus } from './commonModel'

export type DatasourceType = 'oracle' | 'mysql' | 'postgresql'

export interface Datasource {
  id?: string
  name: string
  type: DatasourceType
  host: string
  port: number
  database: string
  username: string
  /** 响应中后端永远脱敏为 "***"；创建/编辑请求体携带明文 */
  password?: string
  remark?: string
  status?: EnabledStatus
  createdAt?: string
  updatedAt?: string
}

export interface DatasourcePageParams extends DatabridgePageParams {
  type?: DatasourceType
  status?: EnabledStatus
}

export interface DatasourceTestParams extends Partial<Datasource> {
  name?: string
  host?: string
  port?: number
  type?: DatasourceType
}

export interface DatasourceTestResult {
  success: boolean
  latencyMs: number
  message: string
}
