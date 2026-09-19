import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'
import type {
  Datasource,
  DatasourcePageParams,
  DatasourceTestParams,
  DatasourceTestResult,
} from './model/datasourceModel'

enum Api {
  Datasource = '/datasources',
  Test = '/datasources/test',
}

/**
 * @description: 数据源分页列表，支持 keyword / type / status
 */
export function getDatasourceListApi(params: DatasourcePageParams) {
  return databridgeHttp.get<DatabridgePageResult<Datasource>>({
    url: Api.Datasource,
    params,
  })
}

/**
 * @description: 数据源详情
 */
export function getDatasourceApi(id: string) {
  return databridgeHttp.get<Datasource>({ url: `${Api.Datasource}/${id}` })
}

/**
 * @description: 供下拉选择使用的一次性拉取（mock 阶段数据量小，直接取前 500 条）
 */
export function getAllDatasourcesApi(keyword?: string) {
  return databridgeHttp
    .get<DatabridgePageResult<Datasource>>({
      url: Api.Datasource,
      params: { page: 1, size: 500, keyword },
    })
    .then((res) => res?.items ?? [])
}

/**
 * @description: 新增数据源
 */
export function createDatasourceApi(data: Datasource) {
  return databridgeHttp.post<Datasource>({ url: Api.Datasource, data })
}

/**
 * @description: 编辑数据源
 */
export function updateDatasourceApi(id: string, data: Datasource) {
  return databridgeHttp.put<Datasource>({ url: `${Api.Datasource}/${id}`, data })
}

/**
 * @description: 删除数据源（被任务引用时后端返回 40002）
 */
export function deleteDatasourceApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Datasource}/${id}` })
}

/**
 * @description: 连通测试（传入尚未保存的配置）
 * mock 规则：host 以 10. 开头或名称含 fail 时返回 success=false
 */
export function testDatasourceApi(data: DatasourceTestParams) {
  return databridgeHttp.post<DatasourceTestResult>({ url: Api.Test, data })
}

/**
 * @description: 连通测试（已保存的数据源）
 */
export function testSavedDatasourceApi(id: string) {
  return databridgeHttp.post<DatasourceTestResult>({ url: `${Api.Datasource}/${id}/test` })
}
