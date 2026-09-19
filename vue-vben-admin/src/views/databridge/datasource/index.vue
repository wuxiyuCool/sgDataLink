<template>
  <PageWrapper
    title="数据源管理"
    content="维护 DataBridge 的源端/目标端数据源；mock 规则：host 以 10. 开头或名称含 fail 时连通测试必然失败"
  >
    <Card :bordered="false" class="mb-3">
      <Form ref="searchFormRef" :model="query" layout="inline" @finish="handleSearch">
        <FormItem label="名称" name="keyword">
          <Input
            v-model:value="query.keyword"
            allow-clear
            placeholder="数据源名称关键字"
            style="width: 200px"
          />
        </FormItem>
        <FormItem label="类型" name="type">
          <Select
            v-model:value="query.type"
            :options="DATASOURCE_TYPE_OPTIONS"
            allow-clear
            placeholder="全部类型"
            style="width: 150px"
          />
        </FormItem>
        <FormItem label="状态" name="status">
          <Select
            v-model:value="query.status"
            :options="DATASOURCE_STATUS_OPTIONS"
            allow-clear
            placeholder="全部状态"
            style="width: 130px"
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
          新增数据源
        </Button>
      </div>

      <Table
        :columns="datasourceColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1300 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record, text }">
          <template v-if="column.key === 'type'">
            <Tag :color="DATASOURCE_TYPE_TAG_COLORS[record.type] || 'default'">
              {{ getDatasourceTypeLabel(record.type) }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="record.status === 'enabled' ? 'success' : 'default'">
              {{ DATASOURCE_STATUS_LABELS[record.status] || '-' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">{{ formatTime(text) }}</template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button
                type="link"
                size="small"
                :loading="testingId === record.id"
                @click="handleTest(record)"
              >
                连通测试
              </Button>
              <Button type="link" size="small" @click="handleEdit(record)">编辑</Button>
              <Popconfirm
                title="确认删除该数据源？被任务引用时后端会拒绝删除"
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

    <DatasourceModal @register="registerModal" @success="handleModalSuccess" />
  </PageWrapper>
</template>
<script lang="ts" setup>
  import { onMounted, reactive, ref } from 'vue'
  import { Button, Card, Form, Input, Popconfirm, Select, Space, Table, Tag } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useModal } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import {
    deleteDatasourceApi,
    getDatasourceListApi,
    testSavedDatasourceApi,
  } from '/@/api/databridge/datasource'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { Datasource } from '/@/api/databridge/model/datasourceModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    DATASOURCE_STATUS_LABELS,
    DATASOURCE_STATUS_OPTIONS,
    DATASOURCE_TYPE_OPTIONS,
    DATASOURCE_TYPE_TAG_COLORS,
    formatTime,
    getDatasourceTypeLabel,
  } from '../data'
  import { datasourceColumns } from './datasource.data'
  import DatasourceModal from './DatasourceModal.vue'

  const FormItem = Form.Item

  const { createMessage } = useMessage()
  const [registerModal, { openModal }] = useModal()

  const query = reactive({
    keyword: undefined as string | undefined,
    type: undefined as string | undefined,
    status: undefined as string | undefined,
  })

  const testingId = ref<string>('')

  const {
    loading,
    dataSource,
    getPagination,
    search,
    reload,
    reset: resetFetch,
    handleTableChange,
  } = usePagedFetch<Datasource>((params) => getDatasourceListApi(params), query)

  function handleSearch() {
    search()
  }

  function handleReset() {
    resetFetch()
  }

  function handleCreate() {
    openModal(true, { isUpdate: false })
  }

  function handleEdit(record: Datasource) {
    openModal(true, { record, isUpdate: true })
  }

  function handleModalSuccess() {
    reload()
  }

  async function handleTest(record: Datasource) {
    if (!record.id) return
    testingId.value = record.id
    try {
      const result = await testSavedDatasourceApi(record.id)
      if (result?.success) {
        createMessage.success(
          `【${record.name}】连通成功，耗时 ${result.latencyMs ?? '-'} ms`,
        )
      } else {
        createMessage.error(`【${record.name}】连通失败：${result?.message || '未知原因'}`)
      }
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '连通测试请求失败'))
    } finally {
      testingId.value = ''
    }
  }

  async function handleDelete(record: Datasource) {
    if (!record.id) return
    try {
      await deleteDatasourceApi(record.id)
      createMessage.success(`已删除数据源【${record.name}】`)
      reload()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  onMounted(() => {
    search()
  })
</script>
