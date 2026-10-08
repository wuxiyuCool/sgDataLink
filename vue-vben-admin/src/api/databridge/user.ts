import { databridgeHttp } from './http'
import type { DatabridgePageResult } from './model/commonModel'

/** 平台用户（契约 1.11）——密码只出现在写入方向，任何响应都不回传 */

export interface PlatformUser {
  id: string
  username: string
  nickname?: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  mustChangePassword?: boolean
  /** 1.9.5 文档中心免登录访问权限（key 明文走 /auth/doc-key，不在这里） */
  docAccess?: boolean
  /** 契约 1.12 问数对外服务权限位 */
  chatAccess?: boolean
  lastLoginAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export interface PlatformUserPageParams {
  keyword?: string
  role?: string
  status?: string
  page?: number
  size?: number
}

enum Api {
  Users = '/users',
  LoginLogs = '/auth/login-logs',
}

export function getPlatformUsersApi(params: PlatformUserPageParams) {
  return databridgeHttp.get<DatabridgePageResult<PlatformUser>>({ url: Api.Users, params })
}

export function createPlatformUserApi(data: {
  username: string
  nickname?: string
  password: string
  role: string
}) {
  return databridgeHttp.post<PlatformUser>({ url: Api.Users, data })
}

export function updatePlatformUserApi(
  id: string,
  data: { nickname?: string; role?: string; status?: string; docAccess?: boolean; chatAccess?: boolean },
) {
  return databridgeHttp.put<PlatformUser>({ url: `${Api.Users}/${id}`, data })
}

export function deletePlatformUserApi(id: string) {
  return databridgeHttp.delete<boolean>({ url: `${Api.Users}/${id}` })
}

export function resetPlatformUserPasswordApi(id: string, password: string) {
  return databridgeHttp.post<PlatformUser>({ url: `${Api.Users}/${id}/reset-password`, data: { password } })
}

/** 登录日志单项（契约 1.11 审计：成功与失败都记，不含任何口令信息） */
export interface LoginLogItem {
  id: string
  userId?: string | null
  username?: string | null
  ip?: string | null
  ok: boolean
  errorMsg?: string | null
  createdAt?: string | null
}

export interface LoginLogPageParams {
  keyword?: string
  result?: 'success' | 'error'
  startTime?: string
  endTime?: string
  page?: number
  size?: number
}

/** GET /auth/login-logs（JWT+admin，滚动保留 1 万条） */
export function getLoginLogsApi(params: LoginLogPageParams = {}) {
  return databridgeHttp.get<DatabridgePageResult<LoginLogItem>>({ url: Api.LoginLogs, params })
}

/** 契约 1.9.5 本人文档 Key 信息（明文只在 /auth/doc-key* 出现） */
export interface MyDocKeyInfo {
  docAccess: boolean
  docKey?: string | null
  updatedAt?: string | null
}

/** 文档访问日志单项（GET /data-apis/swagger-logs，admin） */
export interface DocAccessLogItem {
  id: string
  userId?: string | null
  username?: string | null
  authType?: 'jwt' | 'docKey' | null
  keyMasked?: string | null
  ip?: string | null
  ok: boolean
  httpStatus?: number | null
  bizCode?: number | null
  keyword?: string | null
  userAgent?: string | null
  errorMsg?: string | null
  createdAt?: string | null
}

export interface DocAccessLogPageParams {
  keyword?: string
  result?: 'success' | 'error'
  authType?: 'jwt' | 'docKey'
  startTime?: string
  endTime?: string
  page?: number
  size?: number
}

enum DocApi {
  DocKey = '/auth/doc-key',
  SwaggerLogs = '/data-apis/swagger-logs',
}

enum ChatKeyApi {
  ChatKey = '/auth/chat-key',
}

/** GET /auth/doc-key：本人查看文档权限与 key */
export function getMyDocKeyApi() {
  return databridgeHttp.get<MyDocKeyInfo>({ url: DocApi.DocKey })
}

/** POST /auth/doc-key/refresh：本人刷新 key（旧 key 立即失效） */
export function refreshMyDocKeyApi() {
  return databridgeHttp.post<MyDocKeyInfo>({ url: `${DocApi.DocKey}/refresh` })
}

/** 契约 1.12 问数对外：本人查看问数权限与 chatKey（明文只回本人） */
export interface MyChatKeyInfo {
  chatAccess: boolean
  chatKey?: string | null
  updatedAt?: string | null
}

/** GET /auth/chat-key */
export function getMyChatKeyApi() {
  return databridgeHttp.get<MyChatKeyInfo>({ url: ChatKeyApi.ChatKey })
}

/** POST /auth/chat-key/refresh：本人刷新问数 Key（旧 key 立即失效） */
export function refreshMyChatKeyApi() {
  return databridgeHttp.post<MyChatKeyInfo>({ url: `${ChatKeyApi.ChatKey}/refresh` })
}

/** GET /data-apis/swagger-logs：文档访问日志（JWT+admin） */
export function getSwaggerLogsApi(params: DocAccessLogPageParams = {}) {
  return databridgeHttp.get<DatabridgePageResult<DocAccessLogItem>>({ url: DocApi.SwaggerLogs, params })
}

