<template>
  <PageWrapper
    title="文档中心"
    content="Data API 自动生成的 OpenAPI 3.0 文档（查看需登录，草稿仅管理员可见）：按数据源筛选、按 path/名称模糊查询；文案可在 Data API 编辑弹窗的「文档配置」中修改"
  >
    <Card :bordered="false" class="mb-3">
      <Form layout="inline" class="gap-y-2" @finish="handleSearch">
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
          <Select
            v-model:value="query.status"
            :options="STATUS_OPTIONS"
            style="width: 150px"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" html-type="submit" :loading="loading">
              <Icon icon="ant-design:search-outlined" class="mr-1" />
              查询
            </Button>
            <Button @click="handleReset">重置</Button>
            <Button :disabled="!spec" @click="handleDownload">
              <Icon icon="ant-design:download-outlined" class="mr-1" />
              下载 swagger.json
            </Button>
          </Space>
        </FormItem>
      </Form>
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
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { SwaggerOperation, SwaggerSpec } from '/@/api/databridge/model/dataapiModel'

  const FormItem = Form.Item
  const CollapsePanel = Collapse.Panel
  const DescriptionsItem = Descriptions.Item

  interface FlatOperation {
    path: string
    method: string
    op: SwaggerOperation
  }

  const { createMessage } = useMessage()
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
    const params = (item.op.parameters || [])
      .filter((p) => p.in === 'query' && p.name !== 'page' && p.name !== 'size')
      .map((p) => `${p.name}=${p.required ? 'xxx' : ''}`)
      .join('&')
    const origin = typeof window === 'undefined' ? 'http://<host>:3001' : window.location.origin
    const keyHeader = item.op['x-databridge']?.authEnabled ? ` \\\n  -H "X-API-Key: <发布后生成>"` : ''
    return `curl "${origin}/ds/${item.path}${params ? `?${params}` : ''}"${keyHeader}`
  }

  onMounted(load)
</script>

<style lang="less" scoped>
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
</style>
