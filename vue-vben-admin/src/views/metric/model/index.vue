<template>
  <PageWrapper
    title="指标中心 · 数据建模"
    content="把物理表登记为模型（reference 引用现有表 / ddl 界面建表），维护字段业务名与角色（维度/时间/度量），指标从度量字段定义"
  >
    <Card :bordered="false" class="mb-3">
      <Form layout="inline" @finish="handleSearch">
        <FormItem label="域" name="domainId">
          <TreeSelect
            v-model:value="query.domainId"
            :tree-data="domainOptions"
            tree-default-expand-all
            allow-clear
            placeholder="全部域"
            style="width: 200px"
          />
        </FormItem>
        <FormItem label="分层" name="layer">
          <Select
            v-model:value="query.layer"
            :options="LAYER_OPTIONS"
            allow-clear
            placeholder="全部分层"
            style="width: 150px"
          />
        </FormItem>
        <FormItem label="关键字" name="keyword">
          <Input v-model:value="query.keyword" allow-clear placeholder="模型/表名" style="width: 180px" />
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
          新建模型
        </Button>
      </div>

      <Table
        :columns="columns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        row-key="id"
        size="middle"
        :scroll="{ x: 1100 }"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'layer'">
            <Tag :color="LAYER_TAG_COLORS[record.layer] || 'default'">{{ record.layer }}</Tag>
          </template>
          <template v-else-if="column.key === 'createType'">
            <Tag>{{ record.createType === 'ddl' ? '界面建表' : '引用表' }}</Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="record.status === 'online' ? 'success' : 'default'">
              {{ record.status === 'online' ? '启用' : '停用' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button type="link" size="small" @click="handleColumns(record)">字段</Button>
              <Button
                type="link"
                size="small"
                :loading="previewingId === record.id"
                @click="handlePreview(record)"
              >
                预览数据
              </Button>
              <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
              <Popconfirm title="确认删除该模型？域内被引用时后端会拒绝" @confirm="handleDelete(record)">
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
      </Table>
    </Card>

    <ModelModal @register="registerModelModal" @success="reload" />
    <ColumnsModal @register="registerColumnsModal" @success="reload" />

    <Modal v-model:visible="dataVisible" :title="`数据预览：${previewModel?.name || ''}`" width="900px" :footer="null">
      <Alert
        v-if="previewError"
        type="error"
        show-icon
        :message="previewError"
        class="mb-3"
      />
      <div v-if="previewResult?.sql" class="sql-block mb-3">{{ previewResult.sql }}</div>
      <Table
        v-if="previewResult?.rows"
        :columns="previewColumns"
        :data-source="previewRows"
        :pagination="{ pageSize: 10 }"
        size="small"
        :scroll="{ x: true }"
        row-key="__idx"
      />
    </Modal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import { useRoute } from 'vue-router'

  import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    Modal,
    Popconfirm,
    Select,
    Space,
    Table,
    Tag,
    TreeSelect,
  } from 'ant-design-vue'

  import { getMetricDomainTreeApi, type MetricDomain } from '/@/api/databridge/metric'
  import {
    deleteMetricModelApi,
    getMetricModelsApi,
    previewModelDataApi,
    type MetricModel,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { Icon } from '/@/components/Icon'
  import { useModal } from '/@/components/Modal'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'

  import { LAYER_OPTIONS, LAYER_TAG_COLORS } from '../data'
  import { usePagedFetch } from '../../databridge/hooks/usePagedFetch'
  import ColumnsModal from './ColumnsModal.vue'
  import ModelModal from './ModelModal.vue'

  const FormItem = Form.Item

  const { createMessage } = useMessage()
  const [registerModelModal, { openModal: openModelModal }] = useModal()
  const [registerColumnsModal, { openModal: openColumnsModal }] = useModal()

  const query = reactive({
    domainId: undefined as string | undefined,
    layer: undefined as string | undefined,
    keyword: undefined as string | undefined,
  })

  // 域管理页「在本域新建模型」跳转带 ?domainId= 时预置筛选
  const route = useRoute()
  if (route.query.domainId) query.domainId = String(route.query.domainId)

  const domainOptions = ref<any[]>([])

  const columns = [
    { title: '模型名称', dataIndex: 'name', key: 'name', width: 180 },
    { title: '物理表', dataIndex: 'tableName', key: 'tableName', width: 220 },
    { title: '分层', key: 'layer', width: 90 },
    { title: '创建方式', key: 'createType', width: 100 },
    { title: '时间列', dataIndex: 'timeColumn', key: 'timeColumn', width: 140 },
    { title: '状态', key: 'status', width: 90 },
    { title: '操作', key: 'action', width: 260, fixed: 'right' as const },
  ]

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<MetricModel>(
    (params) =>
      getMetricModelsApi({
        page: params.page,
        size: params.size,
        domainId: query.domainId,
        layer: query.layer,
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
      const result = await getMetricDomainTreeApi()
      domainOptions.value = toTreeOptions(result?.items ?? [])
    } catch {
      domainOptions.value = []
    }
  }

  function handleSearch() {
    search()
  }

  function handleReset() {
    query.domainId = undefined
    query.layer = undefined
    query.keyword = undefined
    resetFetch()
  }

  function handleCreate() {
    openModelModal(true, { isUpdate: false })
  }

  function handleEdit(record: MetricModel) {
    openModelModal(true, { record, isUpdate: true })
  }

  function handleColumns(record: MetricModel) {
    openColumnsModal(true, { modelId: record.id, modelName: record.name })
  }

  async function handleDelete(record: MetricModel) {
    try {
      await deleteMetricModelApi(record.id)
      createMessage.success(`已删除模型【${record.name}】`)
      reload()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  const dataVisible = ref(false)
  const previewingId = ref('')
  const previewModel = ref<MetricModel | null>(null)
  const previewResult = ref<Awaited<ReturnType<typeof previewModelDataApi>> | null>(null)
  const previewError = ref('')

  const previewColumns = computed(() =>
    (previewResult.value?.columns || []).map((c) => ({
      title: c,
      dataIndex: c,
      key: c,
      ellipsis: true,
    }))
  )

  const previewRows = computed(() =>
    (previewResult.value?.rows || []).map((row, index) => {
      const record: Recordable = { __idx: index }
      ;(previewResult.value?.columns || []).forEach((col, i) => {
        record[col] = row[i]
      })
      return record
    })
  )

  async function handlePreview(record: MetricModel) {
    previewingId.value = record.id
    previewModel.value = record
    previewResult.value = null
    previewError.value = ''
    try {
      previewResult.value = await previewModelDataApi(record.id)
      if (!previewResult.value.executable) {
        previewError.value = previewResult.value.error || '内存模式不发起真实查询'
      }
      dataVisible.value = true
    } catch (error) {
      previewError.value = getApiErrorMessage(error, '预览失败（数据源 SQL 执行错误将透传真实库信息）')
      dataVisible.value = true
    } finally {
      previewingId.value = ''
    }
  }

  onMounted(() => {
    loadDomains()
    search()
  })
</script>

<style lang="less" scoped>
  .sql-block {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    background: #f6f8fa;
    padding: 8px 12px;
    border-radius: 4px;
    word-break: break-all;
  }
</style>
