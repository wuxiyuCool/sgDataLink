<template>
  <PageWrapper
    title="Data API"
    content="对标 FineDataLink 数据服务：把表一键发布为 REST API（GET /ds/{path}），鉴权、IP 白名单与限流真实生效；发布时返回的完整 API Key 只显示一次"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline" @finish="handleSearch">
        <FormItem label="名称" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="服务名称或路径关键字"
            style="width: 200px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="DATAAPI_STATUS_OPTIONS"
            allow-clear
            placeholder="全部状态"
            style="width: 140px"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" html-type="submit">查询</Button>
            <Button @click="handleReset">重置</Button>
          </Space>
        </FormItem>
      </Form>
    </Card>

    <Card :bordered="false">
      <div class="mb-3 flex justify-end">
        <Button type="primary" @click="handleCreate">
          <Icon icon="ant-design:plus-outlined" class="mr-1" />
          新建数据服务
        </Button>
      </div>

      <Table
        :columns="dataApiColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1990 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'path'">
            <Tooltip :title="getRuntimeUrl(record.path)">
              <span class="mono">{{ getRuntimePathText(record) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'datasource'">
            {{ record.datasourceName || record.datasourceId || '-' }} /
            {{ record.tableName || '-' }}
          </template>
          <template v-else-if="column.key === 'fields'">
            <Tooltip :title="getFieldsSummary(record.fields)">
              <span>{{ getFieldsSummary(record.fields) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'queryParams'">
            <Tooltip :title="getQueryParamSummary(record.queryParams)">
              <span>{{ getQueryParamSummary(record.queryParams) }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'authEnabled'">
            <Tag :color="record.authEnabled === false ? 'default' : 'gold'">
              {{ record.authEnabled === false ? '关闭' : '开启' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="getDataApiStatusColor(record.status)">
              {{ getDataApiStatusLabel(record.status) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'invokeCount'">
            {{ formatNumber(record.invokeCount) }}
          </template>
          <template v-else-if="column.key === 'errorLatency'">
            <span :class="Number(record.errorCount || 0) > 0 ? 'text-danger' : ''">
              {{ formatNumber(record.errorCount) }}
            </span>
            / {{ formatNumber(record.avgLatencyMs) }} ms
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            {{ formatTime(record.updatedAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Popconfirm
                v-if="record.status !== 'published'"
                title="确认发布该数据服务？完整 API Key 只在本次响应中出现一次"
                ok-text="发布"
                cancel-text="取消"
                @confirm="handlePublish(record)"
              >
                <Button type="link" size="small" :loading="actionLoading === record.id">
                  发布
                </Button>
              </Popconfirm>
              <Popconfirm
                v-else
                title="确认下线？下线后运行时地址将返回 404（code 40404）"
                ok-text="下线"
                cancel-text="取消"
                @confirm="handleUnpublish(record)"
              >
                <Button type="link" size="small" :loading="actionLoading === record.id">
                  下线
                </Button>
              </Popconfirm>
              <Button type="link" size="small" @click="openDebug(record)">调试</Button>
              <Button type="link" size="small" @click="openStats(record)">统计</Button>
              <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
              <Popconfirm
                title="确认删除该数据服务？"
                ok-text="删除"
                cancel-text="取消"
                @confirm="handleDelete(record)"
              >
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <DataApiModal @register="registerModal" @success="reload" />

    <DataApiDebugDrawer
      v-model:visible="debugVisible"
      :api="currentApi"
      @invoked="reload"
    />

    <DataApiStatsDrawer v-model:visible="statsVisible" :api="currentApi" />

    <Modal
      v-model:visible="keyVisible"
      :closable="false"
      :mask-closable="false"
      :footer="null"
      title="发布成功 · 请立刻保存 API Key"
    >
      <Alert
        class="mb-3"
        type="warning"
        show-icon
        message="完整 API Key 仅本次返回，列表与详情接口只会给出脱敏值；丢失请重新发布生成新 key。"
      />
      <Descriptions :column="1" size="small" bordered>
        <DescriptionsItem label="服务">{{ publishedApi?.name || '-' }}</DescriptionsItem>
        <DescriptionsItem label="运行时地址">
          <span class="mono">{{ getRuntimeUrl(publishedApi?.path || '') }}</span>
        </DescriptionsItem>
        <DescriptionsItem label="限流">
          {{ publishedApi?.rateLimitQps ?? '-' }} QPS
        </DescriptionsItem>
        <DescriptionsItem label="API Key">
          <span class="mono api-key">{{ publishedApiKey || '-' }}</span>
        </DescriptionsItem>
      </Descriptions>
      <div class="mt-3 flex justify-end">
        <Space>
          <Button @click="handleCopyApiKey">
            <Icon icon="ant-design:copy-outlined" class="mr-1" />
            复制 API Key
          </Button>
          <Button type="primary" @click="keyVisible = false">我已保存</Button>
        </Space>
      </div>
    </Modal>
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'
  import {
    Alert,
    Button,
    Card,
    Descriptions,
    Form,
    Input,
    Modal,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useModal } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { copyTextToClipboard } from '/@/hooks/web/useCopyToClipboard'
  import { getAllDatasourcesApi } from '/@/api/databridge/datasource'
  import {
    deleteDataApiItemApi,
    getDataApiListApi,
    publishDataApiApi,
    unpublishDataApiApi,
  } from '/@/api/databridge/dataapi'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { DataApi } from '/@/api/databridge/model/dataapiModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    DATAAPI_STATUS_OPTIONS,
    formatNumber,
    formatTime,
    getDataApiStatusLabel,
    getDataApiStatusColor,
  } from '../data'
  import {
    dataApiColumns,
    getFieldsSummary,
    getQueryParamSummary,
    getRuntimePathText,
    getRuntimeUrl,
  } from './dataapi.data'
  import DataApiModal from './DataApiModal.vue'
  import DataApiDebugDrawer from './DataApiDebugDrawer.vue'
  import DataApiStatsDrawer from './DataApiStatsDrawer.vue'

  const FormItem = Form.Item
  const DescriptionsItem = Descriptions.Item

  const { createMessage } = useMessage()
  const [registerModal, { openModal }] = useModal()

  const query = reactive({
    keyword: undefined as string | undefined,
    status: undefined as string | undefined,
  })

  const actionLoading = ref('')
  const datasourceNames = ref<Record<string, string>>({})
  const currentApi = ref<DataApi | null>(null)
  const debugVisible = ref(false)
  const statsVisible = ref(false)
  const keyVisible = ref(false)
  const publishedApi = ref<DataApi | null>(null)
  const publishedApiKey = ref('')

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<DataApi>((params) => getDataApiListApi(params), query)

  /** 数据源名称仅用于列表展示，取不到就退回 id */
  async function loadDatasourceNames() {
    try {
      const list = await getAllDatasourcesApi()
      const map: Record<string, string> = {}
      list.forEach((item) => {
        if (item.id) map[item.id] = item.name
      })
      datasourceNames.value = map
    } catch {
      datasourceNames.value = {}
    }
  }

  function decorate(record: DataApi): DataApi {
    return { ...record, datasourceName: record.datasourceName || datasourceNames.value[record.datasourceId] }
  }

  function handleSearch() {
    search()
    loadDatasourceNames()
  }

  function handleReset() {
    resetFetch()
  }

  function handleCreate() {
    openModal(true, { isUpdate: false })
  }

  function handleEdit(record: DataApi) {
    openModal(true, { record, isUpdate: true })
  }

  function openDebug(record: DataApi) {
    currentApi.value = decorate(record)
    debugVisible.value = true
  }

  function openStats(record: DataApi) {
    currentApi.value = decorate(record)
    statsVisible.value = true
  }

  async function handlePublish(record: DataApi) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      const result = await publishDataApiApi(record.id)
      const apiKey = String(result?.apiKey ?? '')
      publishedApi.value = { ...record, status: result?.status || 'published' }
      publishedApiKey.value = apiKey
      if (apiKey) {
        keyVisible.value = true
      } else {
        createMessage.success(`数据服务【${record.name}】已发布（响应未返回明文 apiKey）`)
      }
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '发布失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleUnpublish(record: DataApi) {
    if (!record.id) return
    actionLoading.value = record.id
    try {
      await unpublishDataApiApi(record.id)
      createMessage.success(`数据服务【${record.name}】已下线`)
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '下线失败'))
    } finally {
      actionLoading.value = ''
    }
  }

  async function handleDelete(record: DataApi) {
    if (!record.id) return
    try {
      await deleteDataApiItemApi(record.id)
      createMessage.success(`已删除数据服务【${record.name}】`)
      await reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  function handleCopyApiKey() {
    if (!publishedApiKey.value) {
      createMessage.warning('没有可复制的 API Key')
      return
    }
    const ok = copyTextToClipboard(publishedApiKey.value)
    if (ok) createMessage.success('API Key 已复制')
    else createMessage.error('复制失败，请手动选择文本复制')
  }

  // 与其它列表页保持一致：挂载后拉取列表与数据源名称
  onMounted(() => {
    search()
    loadDatasourceNames()
  })
</script>
<style lang="less" scoped>
  .mono {
    font-family: monospace;
  }

  .api-key {
    word-break: break-all;
    font-weight: 600;
    color: #cf1322;
  }

  .text-danger {
    color: #cf1322;
  }
</style>
