<template>
  <PageWrapper
    title="告警管理"
    content="对标 FineDataLink 任务运维：告警规则匹配任务失败 / 管道异常 / 延迟超阈值三类事件并写入告警记录（Mock 阶段 channelResult=mock-sent，不发真实 webhook）"
  >
    <Tabs v-model:activeKey="activeTab" @change="handleTabChange">
      <!-- ------------------------------ 告警规则 ------------------------------ -->
      <TabPane key="rules" tab="告警规则">
        <Card :bordered="false" class="mb-3">
          <Form :model="ruleQuery" layout="inline" @finish="handleRuleSearch">
            <FormItem label="名称" name="keyword">
              <Input
                v-model:value="ruleQuery.keyword"
                allow-clear
                placeholder="规则名称关键字"
                style="width: 200px"
              />
            </FormItem>
            <FormItem label="启用" name="enabled">
              <Select
                v-model:value="ruleQuery.enabled"
                :options="ENABLED_OPTIONS"
                allow-clear
                placeholder="全部"
                style="width: 120px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleRuleReset">重置</Button>
              </Space>
            </FormItem>
          </Form>
        </Card>

        <Card :bordered="false">
          <div class="mb-3 flex justify-end">
            <Button type="primary" @click="handleCreateRule">
              <Icon icon="ant-design:plus-outlined" class="mr-1" />
              新建告警规则
            </Button>
          </div>

          <Table
            :columns="alertRuleColumns"
            :data-source="ruleSource"
            :loading="ruleLoading"
            :pagination="rulePagination"
            :scroll="{ x: 1330 }"
            row-key="id"
            size="middle"
            @change="handleRuleTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'conditions'">
                <Space wrap :size="4">
                  <Tag v-for="item in record.conditions || []" :key="item" color="blue">
                    {{ getAlertConditionLabel(item) }}
                  </Tag>
                  <span v-if="!(record.conditions || []).length">-</span>
                </Space>
              </template>
              <template v-else-if="column.key === 'thresholdLagMs'">
                {{ record.thresholdLagMs ? `${formatNumber(record.thresholdLagMs)} ms` : '-' }}
              </template>
              <template v-else-if="column.key === 'channels'">
                <Tooltip :title="getChannelsText(record.channels)">
                  <span>{{
                    (record.channels || [])
                      .map((item) => getAlertChannelLabel(item.type))
                      .join('、') || '未配置'
                  }}</span>
                </Tooltip>
              </template>
              <template v-else-if="column.key === 'enabled'">
                <Tag :color="record.enabled === false ? 'default' : 'success'">
                  {{ record.enabled === false ? '停用' : '启用' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'createdAt'">
                {{ formatTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'action'">
                <Space :size="0">
                  <Button type="link" size="small" @click="handleEditRule(record)">编辑</Button>
                  <Popconfirm
                    title="确认删除该告警规则？"
                    ok-text="删除"
                    cancel-text="取消"
                    @confirm="handleDeleteRule(record)"
                  >
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              </template>
            </template>
          </Table>
        </Card>
      </TabPane>

      <!-- ------------------------------ 告警记录 ------------------------------ -->
      <TabPane key="records" tab="告警记录">
        <Card :bordered="false" class="mb-3">
          <Form :model="recordQuery" layout="inline" @finish="handleRecordSearch">
            <FormItem label="级别" name="level">
              <Select
                v-model:value="recordQuery.level"
                :options="ALERT_LEVEL_OPTIONS"
                allow-clear
                placeholder="全部级别"
                style="width: 130px"
              />
            </FormItem>
            <FormItem label="状态" name="read">
              <Select
                v-model:value="recordQuery.read"
                :options="ALERT_READ_OPTIONS"
                allow-clear
                placeholder="全部"
                style="width: 120px"
              />
            </FormItem>
            <FormItem label="关键字" name="keyword">
              <Input
                v-model:value="recordQuery.keyword"
                allow-clear
                placeholder="规则或对象名称"
                style="width: 180px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleRecordReset">重置</Button>
                <Button @click="handleRecordReload">
                  <Icon icon="ant-design:reload-outlined" class="mr-1" />
                  刷新
                </Button>
              </Space>
            </FormItem>
          </Form>
        </Card>

        <Card :bordered="false">
          <Table
            :columns="alertRecordColumns"
            :data-source="recordSource"
            :loading="recordLoading"
            :pagination="recordPagination"
            :scroll="{ x: 1470, y: 520 }"
            row-key="id"
            size="middle"
            :row-class-name="getRecordRowClass"
            @change="handleRecordTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'level'">
                <Tag :color="LOG_LEVEL_TAG_COLORS[record.level] || 'default'">{{ record.level }}</Tag>
              </template>
              <template v-else-if="column.key === 'targetName'">
                {{ getTargetText(record) }}
              </template>
              <template v-else-if="column.key === 'message'">
                <Tooltip :title="record.message">
                  <span class="mono">{{ record.message || '-' }}</span>
                </Tooltip>
              </template>
              <template v-else-if="column.key === 'channel'">
                {{ getAlertChannelLabel(record.channel) }}
              </template>
              <template v-else-if="column.key === 'createdAt'">
                {{ formatTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'read'">
                <Tag :color="record.read ? 'default' : 'red'">
                  {{ record.read ? '已读' : '未读' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'action'">
                <Button
                  type="link"
                  size="small"
                  :disabled="!!record.read"
                  :loading="markingId === record.id"
                  @click="handleMarkRead(record)"
                >
                  标记已读
                </Button>
              </template>
            </template>
          </Table>
        </Card>
      </TabPane>
    </Tabs>

    <AlertRuleModal @register="registerModal" @success="handleRuleModalSuccess" />
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
    Tabs,
    Tag,
    Tooltip,
  } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useModal } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import {
    deleteAlertRuleApi,
    getAlertRecordListApi,
    getAlertRuleListApi,
    markAlertRecordReadApi,
  } from '/@/api/databridge/alert'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type { AlertRecord, AlertRule } from '/@/api/databridge/model/alertModel'
  import type { SelectOption } from '../data'
  import {
    ALERT_LEVEL_OPTIONS,
    ALERT_READ_OPTIONS,
    LOG_LEVEL_TAG_COLORS,
    formatNumber,
    formatTime,
    getAlertChannelLabel,
    getAlertConditionLabel,
  } from '../data'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import {
    alertRecordColumns,
    alertRuleColumns,
    getChannelsText,
    getRecordRowClass,
    getTargetText,
  } from './alert.data'
  import AlertRuleModal from './AlertRuleModal.vue'

  const FormItem = Form.Item
  const TabPane = Tabs.TabPane

  const ENABLED_OPTIONS: SelectOption[] = [
    { label: '启用', value: true },
    { label: '停用', value: false },
  ]

  const { createMessage } = useMessage()
  const [registerModal, { openModal }] = useModal()

  const activeTab = ref('rules')
  const markingId = ref('')
  const recordsLoaded = ref(false)

  const ruleQuery = reactive({
    keyword: undefined as string | undefined,
    enabled: undefined as boolean | undefined,
  })
  const recordQuery = reactive({
    level: undefined as string | undefined,
    read: undefined as boolean | undefined,
    keyword: undefined as string | undefined,
  })

  const {
    loading: ruleLoading,
    dataSource: ruleSource,
    getPagination: rulePagination,
    search: searchRules,
    reload: reloadRules,
    reset: resetRules,
    handleTableChange: handleRuleTableChange,
  } = usePagedFetch<AlertRule>((params) => getAlertRuleListApi(params), ruleQuery)

  const {
    loading: recordLoading,
    dataSource: recordSource,
    getPagination: recordPagination,
    search: searchRecords,
    reload: reloadRecords,
    reset: resetRecords,
    handleTableChange: handleRecordTableChange,
  } = usePagedFetch<AlertRecord>((params) => getAlertRecordListApi(params), recordQuery)

  function handleTabChange(key: string) {
    if (key === 'records' && !recordsLoaded.value) {
      recordsLoaded.value = true
      searchRecords()
    }
  }

  function handleRuleSearch() {
    searchRules()
  }

  function handleRuleReset() {
    resetRules()
  }

  function handleCreateRule() {
    openModal(true, { isUpdate: false })
  }

  function handleEditRule(record: AlertRule) {
    openModal(true, { record, isUpdate: true })
  }

  function handleRuleModalSuccess() {
    reloadRules()
  }

  async function handleDeleteRule(record: AlertRule) {
    if (!record.id) return
    try {
      await deleteAlertRuleApi(record.id)
      createMessage.success(`已删除告警规则【${record.name}】`)
      await reloadRules()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  function handleRecordSearch() {
    recordsLoaded.value = true
    searchRecords()
  }

  function handleRecordReset() {
    recordQuery.level = undefined
    recordQuery.read = undefined
    recordsLoaded.value = true
    resetRecords()
  }

  function handleRecordReload() {
    recordsLoaded.value = true
    reloadRecords()
  }

  async function handleMarkRead(record: AlertRecord) {
    if (!record.id) return
    markingId.value = record.id
    try {
      await markAlertRecordReadApi(record.id)
      record.read = true
      createMessage.success(`告警记录【${record.id}】已标记为已读`)
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '标记已读失败'))
    } finally {
      markingId.value = ''
    }
  }

  onMounted(() => {
    searchRules()
  })
</script>
<style lang="less" scoped>
  .mono {
    font-family: monospace;
  }

  /* 未读告警整行加粗，便于在长列表里扫一眼定位 */
  :deep(.alert-row-unread) {
    td {
      font-weight: 600;
    }
  }
</style>
