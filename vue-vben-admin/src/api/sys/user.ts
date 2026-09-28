import { databridgeHttp } from '/@/api/databridge/http'
import { LoginParams, LoginResultModel, GetUserInfoModel } from './model/userModel'

import { ErrorMessageMode } from '/#/axios'

/**
 * 登录链路已从脚手架 mock(/basic-api) 切到 DataBridge 真实后端（契约 1.11）：
 * /api/v1/auth/login、/auth/me、/auth/change-password。
 * 响应信封与 defHttp 一致，但 token 走 databridgeHttp 的 Authorization 注入，
 * 与业务接口共享同一份 access token（auth store）。
 */
enum Api {
  Login = '/auth/login',
  GetUserInfo = '/auth/me',
  ChangePassword = '/auth/change-password',
}

interface AuthMe {
  id: string
  username: string
  nickname: string
  role: string
  status: string
  mustChangePassword?: boolean
  lastLoginAt?: string | null
  createdAt?: string | null
}

/**
 * @description: user login api
 */
export function loginApi(params: LoginParams, mode: ErrorMessageMode = 'modal') {
  return databridgeHttp.post<LoginResultModel>(
    {
      url: Api.Login,
      data: { username: params.username, password: params.password },
    },
    {
      errorMessageMode: mode,
    },
  )
}

/** /auth/me → vben GetUserInfoModel（roles 形状保持 [{value, roleName}]，homePath 固定监控总览） */
function toUserInfoModel(me: AuthMe): GetUserInfoModel {
  return {
    userId: me.id,
    username: me.username,
    realName: me.nickname || me.username,
    avatar: '',
    desc: me.role === 'admin' ? '系统管理员' : '普通用户',
    roles: [{ roleName: me.role === 'admin' ? '超级管理员' : '普通用户', value: me.role }],
    homePath: '/monitor/overview',
    // 契约 1.11：初始/被重置密码首登，前端强制弹改密
    mustChangePassword: !!me.mustChangePassword,
  } as GetUserInfoModel
}

/**
 * @description: getUserInfo
 */
export async function getUserInfo() {
  const me = await databridgeHttp.get<AuthMe>({ url: Api.GetUserInfo }, { errorMessageMode: 'none' })
  return toUserInfoModel(me)
}

export async function getPermCode() {
  const me = await databridgeHttp.get<AuthMe>({ url: Api.GetUserInfo }, { errorMessageMode: 'none' })
  return [me.role]
}

/** JWT 无状态：登出只需清本地 token（服务端无会话可吊销，短有效期兜底） */
export function doLogout() {
  return Promise.resolve()
}

export function changePasswordApi(oldPassword: string, newPassword: string) {
  return databridgeHttp.post({ url: Api.ChangePassword, data: { oldPassword, newPassword } })
}
