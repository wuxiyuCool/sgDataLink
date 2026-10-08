<template>
  <PageWrapper
    title="指标中心 · 指标管理"
    content="原子（度量/字段级）、派生（继承基底+限定）、复合（${code} 公式）三类指标；保存即版本，支持公式校验、展开树、血缘、试跑与回滚"
  >
    <GuideCard :guide="PAGE_GUIDES.metric" />
    <Card :bordered="false" class="mb-3">
      <Form layout="inline" @finish="handleSearch">
        <FormItem label="域" name="domainId">
          <TreeSelect
            v-model:value="query.domainId"
            :tree-data="domainOptions"
            tree-default-expand-all
            allow-clear
            placeholder="全部域"
            style="width: 180px"
          />
        </FormItem>
        <FormItem label="类型" name="type">
          <Select
            v-model:value="query.type"
            :options="METRIC_TYPE_OPTIONS"
            allow-clear
            placeholder="全部"
            style="width: 140px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="METRIC_STATUS_OPTIONS"
            allow-clear
            placeholder="全部"
            style="width: 120px"
          />
        </FormItem>
        <FormItem label="关键字" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="名称/编码/别名"
            style="width: 180px"
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
          新建指标
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        row-key="id"
        size="middle"
        :scroll="{ x: 1150 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'type'">
            <Tag :color="METRIC_TYPE_TAG_COLORS[record.type]">
              {{ METRIC_TYPE_LABELS[record.type] || record.type }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="METRIC_STATUS_TAG_COLORS[record.status]">
              {{ METRIC_STATUS_LABELS[record.status] || record.status }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button type="link" size="small" @click="handleDetail(record, 'tree')">公式树</Button>
              <Button type="link" size="small" @click="handleDetail(record, 'preview')"
                >试跑</Button
              >
              <Button type="link" size="small" @click="handleDetail(record, 'versions')"
                >版本</Button
              >
              <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
              <Popconfirm
                title="确认删除？被其他指标引用时后端会拒绝（40903）"
                @confirm="handleDelete(record)"
              >
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <MetricModal @register="registerFormModal" @success="reload" />
    <MetricDetailModal @register="registerDetailModal" @success="reload" />
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'

  import {
    Button,
    Card,
    Form,
    Input,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
    TreeSelect,
  } from 'ant-design-vue'

  import {
    deleteMetricApi,
    getMetricDomainTreeApi,
    getMetricsApi,
    type MetricDomain,
    type MetricItem,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { useModal } from '/@/components/Modal'
  import { PageWrapper } from '/@/components/Page'
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { usePagedFetch } from '../../databridge/hooks/usePagedFetch'
  import {
    METRIC_STATUS_LABELS,
    METRIC_STATUS_OPTIONS,
    METRIC_STATUS_TAG_COLORS,
    METRIC_TYPE_LABELS,
    METRIC_TYPE_OPTIONS,
    METRIC_TYPE_TAG_COLORS,
    formatTime,
  } from '../data'
  import MetricDetailModal from './MetricDetailModal.vue'
  import MetricModal from './MetricModal.vue'

  const FormItem = Form.Item

  const { createMessage } = useMessage()
  const [registerFormModal, { openModal: openFormModal }] = useModal()
  const [registerDetailModal, { openModal: openDetailModal }] = useModal()

  const query = reactive({
    domainId: undefined as string | undefined,
    type: undefined as string | undefined,
    status: undefined as string | undefined,
    keyword: undefined as string | undefined,
  })

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name', width: 170 },
    { title: '编码', dataIndex: 'code', key: 'code', width: 170 },
    { title: '类型', key: 'type', width: 90 },
    { title: '状态', key: 'status', width: 90 },
    { title: '单位', dataIndex: 'unit', key: 'unit', width: 80 },
    { title: '口径', dataIndex: 'caliber', key: 'caliber', width: 200, ellipsis: true },
    { title: '版本', dataIndex: 'version', key: 'version', width: 70 },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      customRender: ({ text }: any) => formatTime(text),
    },
    { title: '操作', key: 'action', width: 250, fixed: 'right' as const },
  ]

  const domainOptions = ref<any[]>([])

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<MetricItem>(
    (params) =>
      getMetricsApi({
        page: params.page,
        size: params.size,
        domainId: query.domainId,
        type: query.type,
        status: query.status,
        keyword: query.keyword,
      }),
    query,
  )

  function toTreeOptions(nodes: MetricDomain[]): any[] {
    return nodes.map((node) => ({
      value: node.id,
      title: node.name,
      children: node.children?.length ? toTreeOptions(node.children) : undefined,
    }))
  }

  async function loadDomains() {
    try {
      const tree = await getMetricDomainTreeApi()
      domainOptions.value = toTreeOptions(tree?.items ?? [])
    } catch {
      domainOptions.value = []
    }
  }

  function handleSearch() {
    search()
  }

  function handleReset() {
    query.domainId = undefined
    query.type = undefined
    query.status = undefined
    query.keyword = undefined
    resetFetch()
  }

  function handleCreate() {
    openFormModal(true, { isUpdate: false, domainOptions: domainOptions.value })
  }

  function handleEdit(record: MetricItem) {
    openFormModal(true, { record, isUpdate: true, domainOptions: domainOptions.value })
  }

  function handleDetail(record: MetricItem, tab: string) {
    openDetailModal(true, { record, tab })
  }

  async function handleDelete(record: MetricItem) {
    try {
      await deleteMetricApi(record.id)
      createMessage.success(`已删除指标【${record.name}】`)
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(() => {
    loadDomains()
    search()
  })
</script>
