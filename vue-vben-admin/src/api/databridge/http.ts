import { createAxios } from '/@/utils/http/axios'

/**
 * DataBridge 管理后端（Node Express，默认端口 3001）接口前缀。
 *
 * 为什么不复用全局 VITE_GLOB_API_URL(/basic-api)：
 * vben 自带的登录 /getUserInfo /getMenuList 等接口由 mock 服务在 /basic-api/* 下提供，
 * 改全局前缀会导致无法登录。因此这里按 `/@/utils/http/axios` 注释中 "other api url"
 * 的方式单独创建实例，响应信封 { code, message, result } 与默认 defHttp 完全一致。
 *
 * dev：vite proxy 将 /api/v1 转发到 http://127.0.0.1:3001/api/v1（见 .env.development）
 * prod：nginx location /api/ 反向代理到 http://databridge-admin:3001（见 build/nginx.conf）
 */
export const DATABRIDGE_API_URL: string =
  import.meta.env.VITE_GLOB_DATABRIDGE_API_URL || '/api/v1'

export const databridgeHttp = createAxios({
  requestOptions: {
    apiUrl: DATABRIDGE_API_URL,
  },
})

/**
 * 后端业务错误（HTTP 4xx + code !== 0）时 axios 会直接 reject，
 * vben 全局 checkStatus 对 400 只读取 data.error.message，取不到提示，
 * 因此页面侧统一用本方法解析出可读文案再自行 createMessage.error。
 */
export function getApiErrorMessage(error: any, fallback = '操作失败，请稍后重试'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  const data = error?.response?.data
  return (
    data?.message ||
    data?.result?.message ||
    (error as Error)?.message ||
    error?.err?.message ||
    fallback
  )
}
