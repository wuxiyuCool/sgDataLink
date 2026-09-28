<template>
  <PageWrapper
    title="调用日志"
    content="Data API 运行时调用审计明细：按服务名、时间范围、成功/失败、调用内容（脱敏 query / 错误信息）组合查询；后端滚动保留最近 5000 条，apiKey 一律脱敏存储，明细不随服务删除而消失"
  >
    <Card :bordered="false" class="mb-3">
      <Form :model="query" layout="inline" class="gap-y-2" @finish="handleSearch">
        <FormItem label="服务名" name="apiName">
          <Input
            v-model:value="query.apiName"
            allow-clear
            placeholder="服务名称或路径关键字"
            style="width: 190px"
          />
        </FormItem>
        <FormItem label="结果" name="result">
          <Select
            v-model:value="query.result"
            :options="RESULT_OPTIONS"
            allow-clear
            placeholder="全部"
            style="width: 120px"
          />
        </FormItem>
        <FormItem label="时间" name="range">
          <RangePicker
            v-model:value="rangeValue"
            show-time
            value-format="YYYY-MM-DD HH:mm:ss"
            :placeholder="['开始时间', '结束时间']"
            style="width: 350px"
          />
        </FormItem>
        <FormItem label="调用内容" name="content">
          <Input
            v-model:value="query.content"
            allow-clear
            placeholder="参数或错误信息模糊匹配"
            style="width: 200px"
          />
        </FormItem>
        <FormItem>
          <Space>
            <Button type="primary" html-type="submit">
              <Icon icon="ant-design:search-outlined" class="mr-1" />
              查询
            </Button>
            <Button @click="handleReset">重置</Button>
          </Space>
        </FormItem>
      </Form>
    </Card>

    <Card :bordered="false">
      <Table
        :columns="callColumns"
        :data-source="dataSource"
        :loading="loading"
        :pagination="getPagination"
        :scroll="{ x: 1400 }"
        row-key="id"
        size="middle"
        @change="handleTableChange"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'path'">
            <span class="mono">{{ record.path || '-' }}</span>
          </template>
          <template v-else-if="column.key === 'ok'">
            <Tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? '成功' : '失败' }}</Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Space :size="4">
              <Tag :color="httpTagColor(record.httpStatus)">{{ record.httpStatus ?? '-' }}</Tag>
              <Tag v-if="record.bizCode" color="volcano">{{ record.bizCode }}</Tag>
            </Space>
          </template>
          <template v-else-if="column.key === 'latencyMs'">
            {{ record.latencyMs ?? '-' }} ms
          </template>
          <template v-else-if="column.key === 'query'">
            <Tooltip :title="record.query">
              <span class="ellipsis-cell mono">{{ record.query || '-' }}</span>
            </Tooltip>
          </template>
          <template v-else-if="column.key === 'errorMsg'">
            <Tooltip :title="record.errorMsg">
              <span class="ellipsis-cell" :class="record.errorMsg ? 'text-red-500' : ''">
                {{ record.errorMsg || '-' }}
              </span>
            </Tooltip>
          </template>
        </template>
        <template #expandedRowRender="{ record }">
          <Descriptions :column="1" size="small" bordered>
            <DescriptionsItem label="调用 ID">{{ record.id }}</DescriptionsItem>
            <DescriptionsItem label="服务">{{ record.apiName || '-' }}（{{ record.apiId || '未知 id' }}）</DescriptionsItem>
            <DescriptionsItem label="请求">
              <span class="mono">{{ record.method || 'GET' }} /ds/{{ record.path }}</span>
            </DescriptionsItem>
            <DescriptionsItem label="参数（已脱敏）">
              <pre class="json-pre">{{ prettyQuery(record.query) }}</pre>
            </DescriptionsItem>
            <DescriptionsItem label="错误信息">{{ record.errorMsg || '-' }}</DescriptionsItem>
          </Descriptions>
        </template>
      </Table>
    </Card>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Button,
    Card,
    DatePicker,
    Descriptions,
    Form,
    Input,
    Select,
    Space,
    Table,
    Tag,
    Tooltip,
  } from 'ant-design-vue'

  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { getApiCallsApi } from '/@/api/databridge/dataapi'
  import type { DataApiCallItem } from '/@/api/databridge/model/dataapiModel'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import { formatTime } from '../data'

  const FormItem = Form.Item
  const RangePicker = DatePicker.RangePicker
  const DescriptionsItem = Descriptions.Item

  const RESULT_OPTIONS = [
    { label: '成功', value: 'success' },
    { label: '失败', value: 'error' },
  ]

  const callColumns = [
    { title: '时间', key: 'createdAt', dataIndex: 'createdAt', width: 170 },
    { title: '服务名', dataIndex: 'apiName', width: 160, ellipsis: true },
    { title: '路径', key: 'path', dataIndex: 'path', width: 140 },
    { title: '方法', dataIndex: 'method', width: 70 },
    { title: '状态码', key: 'status', width: 120 },
    { title: '结果', key: 'ok', dataIndex: 'ok', width: 80 },
    { title: '耗时', key: 'latencyMs', width: 100 },
    { title: '来源 IP', dataIndex: 'ip', width: 130, ellipsis: true },
    { title: '调用参数（脱敏）', key: 'query', width: 260 },
    { title: '错误信息', key: 'errorMsg', width: 260 },
  ]

  const query = reactive<{ apiName?: string; result?: string; content?: string }>({})
  const rangeValue = ref<[string, string] | undefined>(undefined)

  // usePagedFetch 内部 unref(extraParams)：传 computed 即可实时取最新筛选条件
  const { dataSource, loading, getPagination, fetch, handleTableChange } = usePagedFetch<DataApiCallItem>(
    getApiCallsApi,
    computed(() => ({
      apiName: query.apiName || undefined,
      result: query.result || undefined,
      content: query.content || undefined,
      startTime: rangeValue.value?.[0] || undefined,
      endTime: rangeValue.value?.[1] || undefined,
    })) as unknown as Recordable,
  )

  function httpTagColor(status?: number | string | null) {
    const code = Number(status) || 0
    if (code < 400) return 'success'
    if (code < 500) return 'warning'
    return 'error'
  }

  function prettyQuery(raw?: string | null) {
    if (!raw) return '-'
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }

  function handleSearch() {
    fetch()
  }

  function handleReset() {
    query.apiName = undefined
    query.result = undefined
    query.content = undefined
    rangeValue.value = undefined
    fetch()
  }

  onMounted(fetch)
</script>

<style lang="less" scoped>
  .mono {
    font-family: consolas, monospace;
  }

  .ellipsis-cell {
    display: inline-block;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  .json-pre {
    max-height: 160px;
    margin: 0;
    overflow: auto;
    font-family: consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
