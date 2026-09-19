import { computed, reactive, ref, unref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { DatabridgePageParams, DatabridgePageResult } from '/@/api/databridge/model/commonModel'
import { getApiErrorMessage } from '/@/api/databridge/http'
import { useMessage } from '/@/hooks/web/useMessage'

const { createMessage } = useMessage()

export interface PagedFetchOptions {
  /** 默认分页大小 */
  pageSize?: number
  /** 请求失败时是否弹出 message 提示，默认 true */
  showError?: boolean
}

/**
 * @description: 列表页分页拉取封装（脚手架 thin 分支未内置 BasicTable，
 * 这里以 ant-design-vue Table 的 pagination/@change 约定实现统一的分页状态管理）
 *
 * @param loader 接收 { page, size, ...extraParams } 的接口方法
 * @param extraParams 额外的查询条件（响应式对象，调用 fetch 时实时取值）
 */
export function usePagedFetch<T>(
  loader: (params: DatabridgePageParams) => Promise<DatabridgePageResult<T> | undefined>,
  extraParams: Recordable = reactive({}),
  options: PagedFetchOptions = {},
) {
  const { pageSize = 20, showError = true } = options

  const loading = ref(false)
  const dataSource = ref([]) as Ref<T[]>
  const total = ref(0)
  const state = reactive({ page: 1, size: pageSize })

  const getPagination = computed(() => ({
    current: state.page,
    pageSize: state.size,
    total: unref(total),
    showSizeChanger: true,
    showQuickJumper: true,
    pageSizeOptions: ['10', '20', '50', '100'],
    showTotal: (t: number) => `共 ${t} 条`,
  })) as ComputedRef<any>

  async function fetch() {
    loading.value = true
    try {
      const res = await loader({ page: state.page, size: state.size, ...unref(extraParams) })
      dataSource.value = res?.items ?? []
      total.value = res?.total ?? 0
    } catch (error: any) {
      dataSource.value = []
      total.value = 0
      if (showError) {
        createMessage.error(getApiErrorMessage(error, '列表加载失败'))
      }
    } finally {
      loading.value = false
    }
  }

  /** 条件变化后从第一页开始查询 */
  function search() {
    state.page = 1
    return fetch()
  }

  /** 保持当前页刷新 */
  function reload() {
    return fetch()
  }

  function reset() {
    Object.keys(extraParams).forEach((key) => {
      extraParams[key] = undefined
    })
    state.page = 1
    return fetch()
  }

  /** ant-design-vue Table @change */
  function handleTableChange(pagination: any) {
    state.page = pagination?.current ?? state.page
    state.size = pagination?.pageSize ?? state.size
    return fetch()
  }

  return {
    loading,
    dataSource,
    total,
    state,
    getPagination,
    fetch,
    search,
    reload,
    reset,
    handleTableChange,
  }
}
