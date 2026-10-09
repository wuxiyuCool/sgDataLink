<template>
  <PageWrapper
    title="指标中心 · 指标广场"
    content="按指标域浏览已上架指标；从表直接生成原子指标，再做派生（继承+限定）与复合（${code} 公式）。保存即版本，支持校验、公式展开树、血缘、试跑与回滚"
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
            placeholder="全部域（含子域）"
            style="width: 200px"
          />
        </FormItem>
        <FormItem label="类型" name="type">
          <Select
            v-model:value="query.type"
            :options="METRIC_TYPE_OPTIONS"
            allow-clear
            placeholder="全部"
            style="width: 130px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="PLAZA_STATUS_OPTIONS"
            style="width: 150px"
          />
        </FormItem>
        <FormItem label="关键字" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="名称/编码/别名/口径"
            style="width: 200px"
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
      <div class="plaza-toolbar mb-3">
        <Radio.Group v-model:value="viewMode" button-style="solid" @change="handleViewChange">
          <Radio.Button value="plaza">
            <Icon icon="ant-design:appstore-outlined" class="mr-1" />广场
          </Radio.Button>
          <Radio.Button value="table">
            <Icon icon="ant-design:ordered-list-outlined" class="mr-1" />表格
          </Radio.Button>
        </Radio.Group>
        <div class="plaza-toolbar__right">
          <Button @click="handleCreate">
            <Icon icon="ant-design:edit-outlined" class="mr-1" />
            手工新建
          </Button>
          <Button type="primary" class="ml-2" @click="handleBatchFromTable">
            <Icon icon="ant-design:table-outlined" class="mr-1" />
            从表生成指标
          </Button>
        </div>
      </div>

      <Alert
        v-if="viewMode === 'plaza' && plaza.truncated"
        class="mb-3"
        type="warning"
        show-icon
        message="指标数量超过单次展示上限（500），已按热度截断。请用域筛选或关键字收窄。"
      />

      <Spin :spinning="viewMode === 'plaza' ? plazaLoading : loading">
        <template v-if="viewMode === 'plaza'">
          <div v-if="!plazaSections.length" class="plaza-empty">
            <Empty
              :description="
                query.keyword || query.domainId
                  ? '没有符合条件的指标，换个关键字或把状态切到「全部（含草稿）」'
                  : '广场还空着：先去「数据建模」登记模型（草稿要先启用），再来「从表生成指标」'
              "
            />
          </div>
          <section v-for="section in plazaSections" :key="section.id" class="plaza-section">
            <div class="plaza-section__head">
              <span class="plaza-section__title">{{ section.path.join(' / ') }}</span>
              <Tag>{{ section.total }} 个指标</Tag>
              <span class="plaza-section__code">{{ section.code }}</span>
            </div>
            <List
              :grid="{ gutter: 16, xs: 1, sm: 2, md: 3, lg: 3, xl: 4, xxl: 4 }"
              :data-source="section.items"
            >
              <template #renderItem="{ item }">
                <List.Item>
                  <Card
                    size="small"
                    class="metric-card"
                    :hoverable="true"
                    @click="handleDetail(item)"
                  >
                    <template #title>
                      <span class="metric-card__name">{{ item.name }}</span>
                    </template>
                    <template #extra>
                      <Tag :color="METRIC_TYPE_TAG_COLORS[item.type]">
                        {{ METRIC_TYPE_LABELS[item.type] || item.type }}
                      </Tag>
                    </template>
                    <div class="metric-card__code">
                      {{ item.code }}{{ item.unit ? ` · ${item.unit}` : '' }}
                      <span v-if="item.alias && item.alias.length" class="metric-card__alias">
                        别名 {{ item.alias.join('、') }}
                      </span>
                    </div>
                    <div class="metric-card__caliber">{{
                      item.caliber || '（未填写业务口径）'
                    }}</div>
                    <div class="metric-card__meta">
                      <Tooltip
                        :title="
                          item.modelName
                            ? `取数模型：${item.modelName}`
                            : '复合/派生指标不直接落模型'
                        "
                      >
                        <span class="metric-card__model">
                          <Icon icon="ant-design:database-outlined" :size="12" />
                          {{ item.modelName || '跨指标' }}
                        </span>
                      </Tooltip>
                      <span class="metric-card__stats">
                        <Tooltip title="被多少指标当子依赖引用">
                          <Icon icon="ant-design:branch-outlined" :size="12" />
                          {{ item.referencedBy }}
                        </Tooltip>
                        <Tooltip title="近 7 天问数命中次数">
                          <Icon icon="ant-design:fire-outlined" :size="12" /> {{ item.hot7d }}
                        </Tooltip>
                      </span>
                    </div>
                    <div class="metric-card__actions" @click.stop>
                      <Button type="link" size="small" @click="handleDetail(item, 'tree')"
                        >公式树</Button
                      >
                      <Button type="link" size="small" @click="handleDetail(item, 'preview')"
                        >试跑</Button
                      >
                      <Button type="link" size="small" @click="handleEdit(item)">编辑</Button>
                      <Popconfirm
                        title="确认删除？被其他指标引用时后端会拒绝（40903）"
                        @confirm="handleDelete(item)"
                      >
                        <Button type="link" size="small" danger>删除</Button>
                      </Popconfirm>
                    </div>
                  </Card>
                </List.Item>
              </template>
            </List>
          </section>
        </template>

        <Table
          v-else
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
                <Button type="link" size="small" @click="handleDetail(record, 'tree')"
                  >公式树</Button
                >
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
      </Spin>
    </Card>

    <MetricModal @register="registerFormModal" @success="reloadAll" />
    <MetricDetailModal @register="registerDetailModal" @success="reloadAll" />
    <BatchMetricModal @register="registerBatchModal" @success="reloadAll" />
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Alert,
    Button,
    Card,
    Empty,
    Form,
    Input,
    List,
    Popconfirm,
    Radio,
    Select,
    Space,
    Spin,
    Table,
    Tag,
    Tooltip,
    TreeSelect,
  } from 'ant-design-vue'

  import {
    deleteMetricApi,
    getMetricApi,
    getMetricDomainTreeApi,
    getMetricPlazaApi,
    getMetricsApi,
    type MetricDomain,
    type MetricItem,
    type MetricPlazaCard,
    type MetricPlazaResult,
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
    METRIC_STATUS_TAG_COLORS,
    METRIC_TYPE_LABELS,
    METRIC_TYPE_OPTIONS,
    METRIC_TYPE_TAG_COLORS,
    formatTime,
  } from '../data'
  import BatchMetricModal from './BatchMetricModal.vue'
  import MetricDetailModal from './MetricDetailModal.vue'
  import MetricModal from './MetricModal.vue'

  const FormItem = Form.Item

  /** 广场是「上架目录」，默认只看 online；表格没有 all 语义，等价于不加状态过滤 */
  const PLAZA_STATUS_OPTIONS = [
    { label: '已上架', value: 'online' },
    { label: '草稿', value: 'draft' },
    { label: '已下架', value: 'offline' },
    { label: '全部（含草稿）', value: 'all' },
  ]

  const { createMessage } = useMessage()
  const [registerFormModal, { openModal: openFormModal }] = useModal()
  const [registerDetailModal, { openModal: openDetailModal }] = useModal()
  const [registerBatchModal, { openModal: openBatchModal }] = useModal()

  const viewMode = ref<'plaza' | 'table'>('plaza')
  const query = reactive({
    domainId: undefined as string | undefined,
    type: undefined as string | undefined,
    status: 'online' as string,
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
    search: searchTable,
    reload: reloadTable,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<MetricItem>(
    (params) =>
      getMetricsApi({
        page: params.page,
        size: params.size,
        domainId: query.domainId,
        type: query.type,
        status: query.status === 'all' ? undefined : query.status,
        keyword: query.keyword,
      }),
    query,
  )

  const plaza = ref<MetricPlazaResult>({ domains: [], total: 0, truncated: false, limit: 500 })
  const plazaLoading = ref(false)
  const plazaSections = computed(() => plaza.value.domains || [])

  async function loadPlaza() {
    plazaLoading.value = true
    try {
      plaza.value = await getMetricPlazaApi({
        domainId: query.domainId,
        type: query.type,
        status: query.status as 'draft' | 'online' | 'offline' | 'all',
        keyword: query.keyword,
      })
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '广场加载失败'))
      plaza.value = { domains: [], total: 0, truncated: false, limit: 500 }
    } finally {
      plazaLoading.value = false
    }
  }

  function reloadAll() {
    if (viewMode.value === 'plaza') loadPlaza()
    else reloadTable()
  }

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
    reloadAll()
  }

  function handleViewChange() {
    reloadAll()
  }

  function handleReset() {
    query.domainId = undefined
    query.type = undefined
    query.status = 'online'
    query.keyword = undefined
    resetFetch()
    reloadAll()
  }

  function handleCreate() {
    openFormModal(true, { isUpdate: false, domainOptions: domainOptions.value })
  }

  function handleBatchFromTable() {
    openBatchModal(true, { domainOptions: domainOptions.value })
  }

  /** 广场卡片是精简视图，编辑/详情需要完整定义（expr/defineParams），按 id 取一次详情再开弹窗 */
  async function openFull(
    card: MetricPlazaCard | MetricItem,
    action: (record: MetricItem) => void,
  ) {
    try {
      const full = await getMetricApi(card.id)
      action(full)
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '指标详情加载失败'))
    }
  }

  function handleEdit(record: MetricPlazaCard | MetricItem) {
    openFull(record, (full) =>
      openFormModal(true, { record: full, isUpdate: true, domainOptions: domainOptions.value }),
    )
  }

  function handleDetail(record: MetricPlazaCard | MetricItem, tab?: string) {
    openFull(record, (full) => openDetailModal(true, { record: full, tab }))
  }

  async function handleDelete(record: MetricPlazaCard | MetricItem) {
    try {
      await deleteMetricApi(record.id)
      createMessage.success(`已删除指标【${record.name}】`)
      reloadAll()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(() => {
    loadDomains()
    loadPlaza()
    searchTable()
  })
</script>

<style lang="less" scoped>
  .plaza-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    &__right {
      display: flex;
      align-items: center;
    }
  }

  .plaza-empty {
    padding: 32px 0;
  }

  .plaza-section {
    + .plaza-section {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #f0f0f0;
    }

    &__head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    &__title {
      font-weight: 600;
      font-size: 15px;
    }

    &__code {
      color: #bfbfbf;
      font-size: 12px;
    }
  }

  .metric-card {
    width: 100%;
    cursor: pointer;

    :deep(.ant-card-head) {
      min-height: 40px;
      padding: 0 12px;
    }

    :deep(.ant-card-head-title) {
      padding: 8px 0;
    }

    :deep(.ant-card-body) {
      padding: 10px 12px;
    }

    &__name {
      font-weight: 600;
      font-size: 14px;
    }

    &__code {
      color: #8c8c8c;
      font-size: 12px;
      font-family: Consolas, Monaco, monospace;
    }

    &__alias {
      display: block;
      color: #bfbfbf;
      font-family: inherit;
    }

    &__caliber {
      margin: 6px 0;
      min-height: 34px;
      color: #595959;
      font-size: 12px;
      line-height: 17px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    &__meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: #8c8c8c;
    }

    &__model {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 110px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    &__stats {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      white-space: nowrap;
    }

    &__actions {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed #f0f0f0;
      display: flex;
      justify-content: flex-end;
    }
  }
</style>
