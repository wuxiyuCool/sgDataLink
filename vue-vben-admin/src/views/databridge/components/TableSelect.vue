<template>
  <Select
    :value="value"
    :mode="mode"
    :options="allOptions"
    :loading="loading"
    :disabled="disabled || !datasourceId"
    show-search
    :filter-option="localFilter"
    allow-clear
    :token-separators="tokenSeparators"
    :placeholder="resolvedPlaceholder"
    @update:value="handleValueChange"
    @dropdown-visible-change="handleDropdownOpen"
  />
</template>
<script lang="ts" setup>
  import { computed, ref, unref, watch } from 'vue'

  import { Select } from 'ant-design-vue'

  import { getMetaTablesApi } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { useMessage } from '/@/hooks/web/useMessage'

  /**
   * 表名选择器（契约 1.9.1 meta/tables）：
   * 只在「切换数据源 / 首次打开下拉」时拉一次全量表清单（后端上限 5000），
   * 输入关键字走本地内存过滤，不实时发请求；
   * 已选中的表若不在清单里会补回选项，避免丢值。
   */
  const props = withDefaults(
    defineProps<{
      value?: string | string[]
      datasourceId?: string
      mode?: 'default' | 'multiple' | 'tags'
      placeholder?: string
      disabled?: boolean
      tokenSeparators?: string[]
    }>(),
    {
      value: undefined,
      datasourceId: '',
      mode: 'default',
      placeholder: '',
      disabled: false,
      tokenSeparators: undefined,
    },
  )

  const emit = defineEmits<{
    (e: 'update:value', value: any): void
    (e: 'change', value: any): void
  }>()

  /** Select 的 change 语义透传，保证外层 FormItem 的 trigger:'change' 校验能触发 */
  function handleValueChange(value: any) {
    emit('update:value', value)
    emit('change', value)
  }

  interface SelectOption {
    label: string
    value: string
  }

  const { createMessage } = useMessage()

  const allOptions = ref<SelectOption[]>([])
  const loading = ref(false)

  const resolvedPlaceholder = computed(() => {
    if (props.placeholder) return props.placeholder
    return props.datasourceId ? '输入关键字本地过滤表名' : '请先选择数据源'
  })

  /** 当前已选值（单选/多选统一按数组处理） */
  const currentValues = computed(() => {
    const raw = props.value
    if (Array.isArray(raw)) return raw.map(String)
    return raw ? [String(raw)] : []
  })

  async function loadTables() {
    const datasourceId = String(props.datasourceId ?? '')
    if (!datasourceId) {
      allOptions.value = []
      return
    }
    loading.value = true
    try {
      const list = await getMetaTablesApi({ datasourceId })
      const next = (list ?? []).map((item) => ({
        label: item.comment ? `${item.name}（${item.comment}）` : item.name,
        value: item.name,
      }))
      keepCurrentOptions(next)
      allOptions.value = next
    } catch (error: any) {
      const fallback: SelectOption[] = []
      keepCurrentOptions(fallback)
      allOptions.value = fallback
      createMessage.warning(getApiErrorMessage(error, '表列表加载失败，可手动输入表名'))
    } finally {
      loading.value = false
    }
  }

  /** 搜索结果不含已选表时补回，避免下拉刷新丢值 */
  function keepCurrentOptions(next: SelectOption[]) {
    const present = new Set(next.map((item) => item.value))
    for (const value of unref(currentValues)) {
      if (!present.has(value)) {
        next.unshift({ label: value, value })
        present.add(value)
      }
    }
  }

  /** 本地内存过滤：表名或注释包含关键字（不区分大小写）即命中 */
  function localFilter(input: string, option: any) {
    const keyword = String(input ?? '').trim().toLowerCase()
    if (!keyword) return true
    return `${option?.value ?? ''} ${option?.label ?? ''}`.toLowerCase().includes(keyword)
  }

  function handleDropdownOpen(open: boolean) {
    if (open && !allOptions.value.length && props.datasourceId) loadTables()
  }

  // 切换数据源：旧清单作废，立即重拉一次全量（之后输入不再发请求）
  watch(
    () => props.datasourceId,
    (next) => {
      allOptions.value = []
      if (next) loadTables()
    },
    { immediate: true },
  )

  defineExpose({ loadTables })
</script>
