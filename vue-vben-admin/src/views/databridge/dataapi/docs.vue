<template>
  <PageWrapper
    title="文档中心"
    content="Data API 自动生成的 OpenAPI 3.0 文档（查看需登录，草稿仅管理员可见）：按数据源筛选、按 path/名称模糊查询；文案可在 Data API 编辑弹窗的「文档配置」中修改"
  >
    <Card :bordered="false" class="mb-3">
      <div class="docs-toolbar">
        <Form :model="query" layout="inline" class="gap-y-2" @finish="handleSearch">
          <FormItem label="路径/名称" name="keyword">
            <Input
              v-model:value="query.keyword"
              allow-clear
              placeholder="按 apipath 或服务名模糊查询"
              style="width: 220px"
              @press-enter="handleSearch"
            />
          </FormItem>
          <FormItem label="数据源" name="tag">
            <Select
              v-model:value="query.tag"
              :options="tagOptions"
              allow-clear
              placeholder="全部数据源"
              style="width: 180px"
            />
          </FormItem>
          <FormItem v-if="isAdmin" label="范围" name="status">
            <Select v-model:value="query.status" :options="STATUS_OPTIONS" style="width: 150px" />
          </FormItem>
          <FormItem>
            <Space>
              <Button type="primary" html-type="submit">查询</Button>
              <Button @click="handleReset">重置</Button>
            </Space>
          </FormItem>
        </Form>
        <Button :disabled="!spec" :loading="loading" @click="handleDownload">
          <Icon icon="ant-design:download-outlined" class="mr-1" />
          下载 swagger.json
        </Button>
      </div>
    </Card>

    <Card :bordered="false" class="mb-3" title="我的文档 Key（免登录获取 swagger.json）">
      <template #extra>
        <Tag :color="docKeyInfo?.docAccess ? 'success' : 'default'">
          {{ docKeyInfo?.docAccess ? '已开通' : '未开通' }}
        </Tag>
      </template>
      <template v-if="docKeyInfo?.docAccess && docKeyInfo?.docKey">
        <Space :size="8" wrap>
          <span class="mono doc-key-text">{{ keyVisible ? docKeyInfo.docKey : maskedKey }}</span>
          <Button size="small" @click="keyVisible = !keyVisible">
            {{ keyVisible ? '隐藏' : '显示' }}
          </Button>
          <Button size="small" @click="handleCopyKey">复制</Button>
          <Button size="small" danger :loading="keyRefreshing" @click="handleRefreshKey">
            刷新生成
          </Button>
        </Space>
        <div class="mt-2 text-gray-500">
          {{ docKeyInfo.updatedAt ? `key 生成时间：${formatTime(docKeyInfo.updatedAt)}；` : '' }}
          不刷新则长期保留；刷新后旧 key 立即失效；账号禁用或文档权限被回收时 key 同步失效；
          每次通过 key 取文档都会记入访问日志（管理员可在用户管理页查看）
        </div>
        <pre class="json-pre mt-2">{{ docKeyCurlHint }}</pre>
      </template>
      <div v-else class="text-gray-500">
        尚未开通文档权限：请联系管理员在「系统管理 → 用户管理 → 编辑」中开启「文档中心访问」，开通后自动生成个人 key
      </div>
    </Card>

    <Card :bordered="false" class="mb-3" title="我的问数 Key（对外调用 /api/v1/chat/ask）">
      <template #extra>
        <Tag :color="chatKeyInfo?.chatAccess ? 'success' : 'default'">
          {{ chatKeyInfo?.chatAccess ? '已开通' : '未开通' }}
        </Tag>
      </template>
      <template v-if="chatKeyInfo?.chatAccess && chatKeyInfo?.chatKey">
        <Space :size="8" wrap>
          <span class="mono doc-key-text">{{ chatKeyVisible ? chatKeyInfo.chatKey : chatKeyMasked }}</span>
          <Button size="small" @click="chatKeyVisible = !chatKeyVisible">
            {{ chatKeyVisible ? '隐藏' : '显示' }}
          </Button>
          <Button size="small" @click="handleCopyChatKey">复制</Button>
          <Button size="small" danger :loading="chatKeyRefreshing" @click="handleRefreshChatKey">
            刷新生成
          </Button>
        </Space>
        <div class="mt-2 text-gray-500">
          {{ chatKeyInfo.updatedAt ? `key 生成时间：${formatTime(chatKeyInfo.updatedAt)}；` : '' }}
          刷新后旧 key 立即失效；账号禁用或问数权限被回收时同步失效；每次带 key 的问数调用都会记入审计日志（仅管理员可见）
        </div>
        <pre class="json-pre mt-2">{{ chatKeyCurlHint }}</pre>
      </template>
      <div v-else class="text-gray-500">
        尚未开通问数权限：请联系管理员在「系统管理 → 用户管理 → 编辑」中开启「问数权限」，开通后自动生成个人 Key，
        调用方式见「智能问数」分组文档
      </div>
    </Card>

    <Card :bordered="false">
      <Alert
        v-if="spec"
        class="mb-3"
        type="info"
        show-icon
        :message="`${spec.info?.title || 'DataBridge 数据服务'}（OpenAPI ${spec.openapi}）· 共 ${visibleCount} 个接口${query.status === 'all' ? '（含草稿）' : ''}`"
        :description="spec.info?.description"
      />
      <Empty v-if="!loading && !visibleCount" description="没有符合条件的接口" />
      <Spin :spinning="loading">
        <div v-for="group in tagGroups" :key="group.tag" class="tag-group">
          <div class="tag-title">
            <Icon icon="ion:layers-outline" class="mr-1" />
            {{ group.tag }}
            <span class="tag-count">{{ group.items.length }}</span>
          </div>
          <Collapse ghost>
            <CollapsePanel v-for="item in group.items" :key="`${item.method}-${item.path}`">
              <template #header>
                <Space :size="8">
                  <Tag :color="item.method === 'GET' ? 'blue' : 'purple'">{{ item.method }}</Tag>
                  <span class="mono">/ds/{{ item.path }}</span>
                  <span class="summary-text">{{ item.op.summary }}</span>
                  <Tag v-if="item.op['x-databridge']?.status === 'draft'" color="orange">草稿</Tag>
                </Space>
              </template>
              <Descriptions :column="3" size="small" class="mb-3">
                <DescriptionsItem label="服务">{{ item.op['x-databridge']?.apiName || '-' }}（{{ item.op['x-databridge']?.apiId }}）</DescriptionsItem>
                <DescriptionsItem label="模式">
                  {{ SQL_MODE_LABEL[item.op['x-databridge']?.sqlMode || 'builder'] }}
                </DescriptionsItem>
                <DescriptionsItem label="鉴权/限流">
                  {{ item.op['x-databridge']?.authEnabled ? 'X-API-Key' : '免鉴权' }} · {{ item.op['x-databridge']?.rateLimitQps || '-' }} QPS
                </DescriptionsItem>
                <DescriptionsItem label="说明" :span="3">{{ item.op.description || '-' }}</DescriptionsItem>
              </Descriptions>

              <div class="section-title">请求参数</div>
              <Table
                :columns="PARAM_COLUMNS"
                :data-source="item.op.parameters || []"
                :pagination="false"
                size="small"
                row-key="name"
                :bordered="true"
              >
                <template #bodyCell="{ column: col, record }">
                  <template v-if="col.key === 'type'">{{ paramType(record.schema) }}</template>
                  <template v-else-if="col.key === 'required'">
                    <Tag :color="record.required ? 'red' : 'default'">{{ record.required ? '必填' : '可选' }}</Tag>
                  </template>
                </template>
              </Table>

              <div class="section-title">返回示例</div>
              <Table
                v-if="previewTable(item).columns.length"
                :columns="previewTable(item).columns"
                :data-source="previewTable(item).rows"
                :pagination="false"
                size="small"
                bordered
                :scroll="{ x: true }"
              />
              <pre v-else class="json-pre">{{ JSON.stringify(previewTable(item).raw, null, 2) }}</pre>

              <div class="section-title">调用示例</div>
              <pre class="json-pre">{{ curlOf(item) }}</pre>
            </CollapsePanel>
          </Collapse>
        </div>
      </Spin>
    </Card>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Alert,
    Card,
    Collapse,
    Descriptions,
    Empty,
    Form,
    Input,
    Select,
    Space,
    Spin,
    Table,
    Tag,
  } from 'ant-design-vue'

  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { useUserStore } from '/@/store/modules/user'
  import { getSwaggerDocApi } from '/@/api/databridge/dataapi'
  import {
    getMyChatKeyApi,
    getMyDocKeyApi,
    refreshMyChatKeyApi,
    refreshMyDocKeyApi,
    type MyChatKeyInfo,
    type MyDocKeyInfo,
  } from '/@/api/databridge/user'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { SwaggerOperation, SwaggerSpec } from '/@/api/databridge/model/dataapiModel'
  import { formatTime } from '../data'

  const FormItem = Form.Item
  const CollapsePanel = Collapse.Panel
  const DescriptionsItem = Descriptions.Item

  interface FlatOperation {
    path: string
    method: string
    op: SwaggerOperation
  }

  const { createMessage, createConfirm } = useMessage()
  const userStore = useUserStore()
  const isAdmin = computed(() => {
    const roles = (userStore.getUserInfo?.roles || []) as any[]
    return roles.some((role) => (typeof role === 'string' ? role : role?.value) === 'admin')
  })

  const STATUS_OPTIONS = [
    { label: '仅已发布', value: 'published' },
    { label: '全部（含草稿）', value: 'all' },
  ]
  const SQL_MODE_LABEL: Record<string, string> = {
    builder: '可视化构建',
    custom: '自定义 SQL',
    forward: 'API 转发',
  }
  const PARAM_COLUMNS = [
    { title: '参数名', dataIndex: 'name', width: 160 },
    { title: '位置', dataIndex: 'in', width: 80 },
    { title: '类型', key: 'type', width: 110 },
    { title: '必填', key: 'required', width: 80 },
    { title: '说明', dataIndex: 'description' },
  ]

  const spec = ref<SwaggerSpec | null>(null)
  const loading = ref(false)
  const query = reactive<{ keyword?: string; tag?: string; status: 'published' | 'all' }>({
    keyword: '',
    tag: undefined,
    status: 'published',
  })

  const operations = computed<FlatOperation[]>(() => {
    const rows: FlatOperation[] = []
    Object.entries(spec.value?.paths || {}).forEach(([path, item]) => {
      Object.entries(item || {}).forEach(([method, op]) => {
        rows.push({ path: path.replace(/^\//, ''), method: method.toUpperCase(), op })
      })
    })
    return rows
  })

  const tagOptions = computed(() =>
    (spec.value?.tags || []).map((tag) => ({ label: tag.name, value: tag.name })),
  )

  const tagGroups = computed(() => {
    const groups = new Map<string, FlatOperation[]>()
    operations.value
      .filter((item) => !query.tag || (item.op.tags || []).includes(query.tag))
      .forEach((item) => {
        const tag = (item.op.tags || ['未分组'])[0]
        if (!groups.has(tag)) groups.set(tag, [])
        groups.get(tag)!.push(item)
      })
    return Array.from(groups.entries()).map(([tag, items]) => ({ tag, items }))
  })

  const visibleCount = computed(() =>
    tagGroups.value.reduce((sum, group) => sum + group.items.length, 0),
  )

  async function load() {
    loading.value = true
    try {
      spec.value = await getSwaggerDocApi({
        status: isAdmin.value ? query.status : 'published',
        keyword: query.keyword || undefined,
      })
    } catch (error: any) {
      spec.value = null
      createMessage.error(getApiErrorMessage(error, '加载接口文档失败'))
    } finally {
      loading.value = false
    }
  }

  function handleSearch() {
    load()
  }

  function handleReset() {
    query.keyword = ''
    query.tag = undefined
    query.status = 'published'
    load()
  }

  function handleDownload() {
    if (!spec.value) return
    const blob = new Blob([JSON.stringify(spec.value, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'databridge-swagger.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  function paramType(schema?: Recordable) {
    if (!schema) return 'string'
    if (schema.type === 'array') return `${schema.items?.type || 'string'}[]`
    return schema.type || 'string'
  }

  /** 返回示例：builder/custom 走信封里的 {fields, rows} 预览表；forward 直接贴样例 JSON */
  function previewTable(item: FlatOperation) {
    const empty = { columns: [] as any[], rows: [] as any[], raw: null as any }
    const content = item.op.responses?.['200']?.content?.['application/json']
    const example = content?.example
    if (!example) {
      const fields = content?.schema?.properties?.result?.properties?.fields?.example
      return Array.isArray(fields) && fields.length
        ? {
            columns: fields.map((name: string) => ({ title: name, dataIndex: name })),
            rows: [] as any[],
            raw: { fields },
          }
        : { ...empty, raw: { note: '未配置返回示例，可在文档配置中补充 responseExample' } }
    }
    const result = example.result
    if (Array.isArray(result?.fields) && Array.isArray(result?.rows)) {
      return {
        columns: result.fields.map((name: string) => ({ title: name, dataIndex: name, ellipsis: true })),
        rows: result.rows.map((row: any[]) => {
          const record: Recordable = {}
          result.fields.forEach((field: string, index: number) => {
            record[field] = row[index]
          })
          return record
        }),
        raw: example,
      }
    }
    return { ...empty, raw: example }
  }

  function curlOf(item: FlatOperation) {
    const origin = typeof window === 'undefined' ? 'http://<host>:3001' : window.location.origin
    // 「文档中心」分组是管理端自述接口（api/v1/... 原样），业务条目才是 /ds/{path}
    if (item.path.startsWith('api/v1')) {
      const methodFlag = item.method === 'GET' ? '' : `-X ${item.method} `
      const auth = item.path.includes('swagger.json')
        ? ' -H "X-DOC-KEY: <你的文档Key，见上方面板>"'
        : ' -H "Authorization: Bearer <登录 token>"'
      return `curl ${methodFlag}"${origin}/${item.path}"${auth}`
    }
    const params = (item.op.parameters || [])
      .filter((p) => p.in === 'query' && p.name !== 'page' && p.name !== 'size')
      .map((p) => `${p.name}=${p.required ? 'xxx' : ''}`)
      .join('&')
    const keyHeader = item.op['x-databridge']?.authEnabled ? ` \\\n  -H "X-API-Key: <发布后生成>"` : ''
    return `curl "${origin}/ds/${item.path}${params ? `?${params}` : ''}"${keyHeader}`
  }

  /* ---- 契约 1.12 我的问数 Key（对外调用 /chat/ask） ---- */
  const chatKeyInfo = ref<MyChatKeyInfo | null>(null)
  const chatKeyVisible = ref(false)
  const chatKeyRefreshing = ref(false)

  const chatKeyMasked = computed(() => {
    const k = chatKeyInfo.value?.chatKey || ''
    return k ? `${k.slice(0, 8)}••••••${k.slice(-4)}` : ''
  })

  const chatKeyCurlHint = computed(() => {
    const origin = typeof window === 'undefined' ? 'http://<host>' : window.location.origin
    const shown = chatKeyVisible.value && chatKeyInfo.value?.chatKey ? chatKeyInfo.value.chatKey : '<粘贴你的问数 Key>'
    return `curl -X POST ${origin}/api/v1/chat/ask -H "content-type: application/json" -H "X-CHAT-KEY: ${shown}" -d '{\"question\":\"昨天的订单额是多少\"}'`
  })

  async function loadChatKey() {
    try {
      chatKeyInfo.value = await getMyChatKeyApi()
    } catch {
      chatKeyInfo.value = null
    }
  }

  function handleCopyChatKey() {
    const k = chatKeyInfo.value?.chatKey
    if (!k) return
    navigator.clipboard
      .writeText(k)
      .then(() => createMessage.success('问数 Key 已复制（请视为密码保管，勿截图/入库）'))
      .catch(() => createMessage.warning('浏览器拒绝剪贴板访问，请手动选择复制'))
  }

  function handleRefreshChatKey() {
    createConfirm({
      iconType: 'warning',
      title: '刷新问数 Key',
      content: '刷新后旧 key 立即失效，使用旧 key 的外部脚本需同步更换。确认继续？',
      onOk: async () => {
        chatKeyRefreshing.value = true
        try {
          chatKeyInfo.value = await refreshMyChatKeyApi()
          chatKeyVisible.value = true
          createMessage.success('已生成新问数 Key（旧 key 即刻作废）')
        } catch (error: any) {
          createMessage.error(getApiErrorMessage(error, '刷新失败'))
        } finally {
          chatKeyRefreshing.value = false
        }
      },
    })
  }

  /* ---- 1.9.5 我的文档 Key（免登录取 swagger.json） ---- */
  const docKeyInfo = ref<MyDocKeyInfo | null>(null)
  const keyVisible = ref(false)
  const keyRefreshing = ref(false)

  const maskedKey = computed(() => {
    const k = docKeyInfo.value?.docKey || ''
    return k ? `${k.slice(0, 8)}••••••${k.slice(-4)}` : ''
  })

  const docKeyCurlHint = computed(() => {
    const origin = typeof window === 'undefined' ? 'http://<host>' : window.location.origin
    const shown = keyVisible.value && docKeyInfo.value?.docKey ? docKeyInfo.value.docKey : '<粘贴你的文档 Key>'
    return `curl -H "X-DOC-KEY: ${shown}" ${origin}/api/v1/data-apis/swagger.json`
  })

  async function loadDocKey() {
    try {
      docKeyInfo.value = await getMyDocKeyApi()
    } catch {
      docKeyInfo.value = null
    }
  }

  function handleCopyKey() {
    const k = docKeyInfo.value?.docKey
    if (!k) return
    navigator.clipboard
      .writeText(k)
      .then(() => createMessage.success('文档 Key 已复制（请视为密码保管，勿截图/入库）'))
      .catch(() => createMessage.warning('浏览器拒绝剪贴板访问，请手动选择复制'))
  }

  function handleRefreshKey() {
    createConfirm({
      iconType: 'warning',
      title: '刷新文档 Key',
      content: '刷新后旧 key 立即失效，所有使用旧 key 的脚本/工具需要同步更新。确认继续？',
      onOk: async () => {
        keyRefreshing.value = true
        try {
          docKeyInfo.value = await refreshMyDocKeyApi()
          keyVisible.value = true
          createMessage.success('已生成新文档 Key（旧 key 即刻作废）')
        } catch (error: any) {
          createMessage.error(getApiErrorMessage(error, '刷新失败'))
        } finally {
          keyRefreshing.value = false
        }
      },
    })
  }

  onMounted(() => {
    load()
    loadDocKey()
    loadChatKey()
  })
</script>

<style lang="less" scoped>
  /* 搜索区与其它列表页对齐：左侧筛选表单，右侧页面级动作按钮 */
  .docs-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  .mono {
    font-family: consolas, monospace;
  }

  .summary-text {
    color: rgb(0 0 0 / 65%);
  }

  .tag-group {
    margin-bottom: 16px;
  }

  .tag-title {
    margin-bottom: 4px;
    font-size: 15px;
    font-weight: 600;
  }

  .tag-count {
    margin-left: 6px;
    padding: 0 8px;
    color: rgb(0 0 0 / 45%);
    font-size: 12px;
    background: rgb(0 0 0 / 4%);
    border-radius: 10px;
  }

  .section-title {
    margin: 12px 0 6px;
    font-weight: 600;
  }

  .json-pre {
    max-height: 220px;
    margin: 0;
    padding: 8px 12px;
    overflow: auto;
    font-family: consolas, monospace;
    font-size: 12px;
    background: rgb(0 0 0 / 3%);
    border-radius: 4px;
    white-space: pre-wrap;
  }

  .doc-key-text {
    font-size: 14px;
    font-weight: 600;
  }
</style>
