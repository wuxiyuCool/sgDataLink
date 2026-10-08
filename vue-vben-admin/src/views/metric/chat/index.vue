<template>
  <PageWrapper
    title="指标中心 · 智能问数"
    content="自然语言问指标：召回→生成 M2SQL→纠错→编译为物理 SQL 在真实库执行；指标卡展开子指标公式与取值（需已配置 LLM）"
  >
    <GuideCard :guide="PAGE_GUIDES.chat" />
    <Card :bordered="false">
      <Tabs v-model:activeKey="activeTab">
        <TabPane key="chat" tab="对话">
          <div class="chat-area">
            <div ref="listRef" class="msg-list">
              <div v-for="(msg, index) in messages" :key="index" :class="['msg-row', msg.role]">
                <template v-if="msg.role === 'user'">
                  <div class="bubble user-bubble">{{ msg.text }}</div>
                </template>
                <template v-else>
                  <div class="bubble ai-bubble">
                    <Space class="mb-1">
                      <Tag :color="CHAT_STATUS_TAG_COLORS[msg.result?.status] || 'default'">
                        {{ CHAT_STATUS_LABELS[msg.result?.status] || msg.result?.status }}
                      </Tag>
                      <span v-if="msg.result?.modelName" class="text-gray" style="font-size: 12px">
                        模型：{{ msg.result.modelName }}
                      </span>
                    </Space>
                    <div class="answer-line">
                      <span
                        v-if="msg.result?.value !== undefined && msg.result?.value !== null"
                        class="big-value"
                      >
                        {{ msg.result.value }}
                      </span>
                      <span>{{ msg.result?.answer || msg.text }}</span>
                    </div>
                    <Alert
                      v-if="msg.result?.status === 'failed'"
                      type="error"
                      show-icon
                      :message="msg.result.error || '查询失败'"
                      class="mt-2"
                    />
                    <template v-if="msg.result?.candidates?.length">
                      <div class="mt-2">你是想问：</div>
                      <Space wrap class="mt-1">
                        <Button
                          v-for="cand in msg.result.candidates"
                          :key="cand.id"
                          size="small"
                          @click="ask(`${cand.name}是多少`)"
                        >
                          {{ cand.name }}
                        </Button>
                      </Space>
                    </template>
                    <Table
                      v-if="msg.result?.rows?.length && msg.result.columns?.length"
                      :columns="tableColumns(msg.result.columns)"
                      :data-source="tableRows(msg.result.columns, msg.result.rows)"
                      size="small"
                      :pagination="{ pageSize: 10 }"
                      row-key="__idx"
                      class="mt-2"
                      :scroll="{ x: true }"
                    />
                    <div v-if="msg.result?.metricTree" class="tree-box mt-2">
                      <div class="tree-title">指标公式与子指标：</div>
                      <Tree
                        :tree-data="[treeNodeOf(msg.result.metricTree)]"
                        :field-names="{ title: 'title', key: 'key' }"
                        default-expand-all
                      >
                        <template #title="node">
                          <Space wrap :size="4">
                            <Tag v-if="node.type" :color="METRIC_TYPE_TAG_COLORS[node.type]">
                              {{ METRIC_TYPE_LABELS[node.type] || node.type }}
                            </Tag>
                            <span>{{ node.title }}</span>
                            <span v-if="node.valueText" class="node-value">{{
                              node.valueText
                            }}</span>
                            <span v-if="node.exprText" class="expr-text">{{ node.exprText }}</span>
                          </Space>
                        </template>
                      </Tree>
                    </div>
                    <Collapse
                      v-if="msg.result?.m2sql || msg.result?.physicalSql"
                      ghost
                      class="mt-1"
                    >
                      <CollapsePane key="sql" header="查看 M2SQL / 物理 SQL">
                        <div v-if="msg.result.m2sql" class="sql-block">{{ msg.result.m2sql }}</div>
                        <div v-if="msg.result.physicalSql" class="sql-block mt-1">{{
                          msg.result.physicalSql
                        }}</div>
                      </CollapsePane>
                    </Collapse>
                    <div
                      v-if="msg.result?.warnings?.length"
                      class="text-gray mt-1"
                      style="font-size: 12px"
                    >
                      {{ msg.result.warnings.join('；') }}
                    </div>
                  </div>
                </template>
              </div>
              <div v-if="asking" class="msg-row assistant">
                <div class="bubble ai-bubble text-gray">思考中…（推理模型可能要十几秒）</div>
              </div>
            </div>
            <div class="input-row mt-3">
              <Textarea
                v-model:value="input"
                :rows="2"
                placeholder="如：昨天的订单额是多少？按地区看本周实收额（Enter 发送）"
                @press-enter="handleSend"
              />
              <div class="mt-2 flex justify-between">
                <Space>
                  <Button @click="handleNewSession">清空会话</Button>
                </Space>
                <Button type="primary" :loading="asking" @click="handleSend">发送</Button>
              </div>
            </div>
          </div>
        </TabPane>

        <TabPane v-if="isAdmin" key="history" tab="历史（问数审计）">
          <Space class="mb-3" wrap>
            <Input
              v-model:value="logQuery.keyword"
              allow-clear
              placeholder="问题关键字"
              style="width: 200px"
              @press-enter="loadLogs"
            />
            <Select
              v-model:value="logQuery.status"
              :options="[
                { label: '成功', value: 'success' },
                { label: '纠错后成功', value: 'corrected' },
                { label: '待澄清', value: 'clarify' },
                { label: '失败', value: 'failed' },
              ]"
              allow-clear
              placeholder="结果"
              style="width: 140px"
            />
            <Input
              v-model:value="logQuery.userName"
              allow-clear
              placeholder="提问人"
              style="width: 140px"
            />
            <Button type="primary" @click="loadLogs">查询</Button>
          </Space>
          <Table
            :columns="logColumns"
            :data-source="logs"
            :loading="logsLoading"
            :pagination="logPagination"
            row-key="id"
            size="small"
            :scroll="{ x: 900 }"
            @change="(p: any) => { logPage = p.current; loadLogs() }"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'status'">
                <Tag :color="CHAT_STATUS_TAG_COLORS[record.status]">{{
                  CHAT_STATUS_LABELS[record.status] || record.status
                }}</Tag>
              </template>
              <template v-else-if="column.key === 'createdAt'">{{
                formatTime(record.createdAt)
              }}</template>
              <template v-else-if="column.key === 'action'">
                <Space :size="0">
                  <Button type="link" size="small" @click="reAsk(record)">再问一次</Button>
                  <Popconfirm
                    v-if="isAdmin"
                    title="把这条问答转为 few-shot 示例？"
                    @confirm="handleToExample(record)"
                  >
                    <Button
                      type="link"
                      size="small"
                      :disabled="!record.m2sql || record.status === 'failed'"
                    >
                      转示例
                    </Button>
                  </Popconfirm>
                </Space>
              </template>
            </template>
          </Table>
        </TabPane>
      </Tabs>
    </Card>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref, nextTick, watch } from 'vue'

  import {
    Alert,
    Button,
    Card,
    Collapse,
    Input,
    Popconfirm,
    Select,
    Space,
    Table,
    Tabs,
    Tag,
    Tree,
  } from 'ant-design-vue'

  import {
    chatAskApi,
    clearChatSessionApi,
    getMetricLogsApi,
    logToExampleApi,
    type ChatAskResult,
    type MetricQueryLog,
    type MetricTreeNode,
  } from '/@/api/databridge/metric'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { PageWrapper } from '/@/components/Page'
  import { PAGE_GUIDES } from '../guides'
  import GuideCard from '../components/GuideCard.vue'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { useUserStore } from '/@/store/modules/user'

  import {
    CHAT_STATUS_LABELS,
    CHAT_STATUS_TAG_COLORS,
    METRIC_TYPE_LABELS,
    METRIC_TYPE_TAG_COLORS,
    formatTime,
  } from '../data'

  const TabPane = Tabs.TabPane
  const CollapsePane = Collapse.Panel
  const Textarea = Input.TextArea

  const { createMessage } = useMessage()
  const userStore = useUserStore()
  // getUserInfo 无 role 字段（toUserInfoModel 只映射 roles 数组），用 vben 角色列表判定
  const isAdmin = computed(() => (userStore.getRoleList || []).includes('admin'))

  const activeTab = ref('chat')

  interface ChatMessage {
    role: 'user' | 'assistant'
    text?: string
    result?: ChatAskResult
  }

  const messages = ref<ChatMessage[]>([])
  const input = ref('')
  const asking = ref(false)
  const listRef = ref<HTMLElement>()
  const sessionId = ref(newSessionId())

  function newSessionId() {
    return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  function scrollBottom() {
    nextTick(() => {
      const el = listRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  async function ask(question: string) {
    const text = question.trim()
    if (!text || asking.value) return
    messages.value.push({ role: 'user', text })
    input.value = ''
    asking.value = true
    scrollBottom()
    try {
      const result = await chatAskApi({ question: text, sessionId: sessionId.value })
      messages.value.push({ role: 'assistant', result })
    } catch (error) {
      messages.value.push({
        role: 'assistant',
        result: {
          status: 'failed',
          answer: '问数请求失败',
          error: getApiErrorMessage(error, '请求失败'),
        } as ChatAskResult,
      })
    } finally {
      asking.value = false
      scrollBottom()
    }
  }

  function handleSend() {
    ask(input.value)
  }

  async function handleNewSession() {
    try {
      await clearChatSessionApi(sessionId.value)
    } catch {
      /* 会话可能本就为空，忽略 */
    }
    sessionId.value = newSessionId()
    messages.value = []
    createMessage.success('已开启新会话')
  }

  function tableColumns(cols: string[]) {
    return cols.map((c) => ({ title: c, dataIndex: c, key: c, ellipsis: true }))
  }

  function tableRows(cols: string[], rows: any[][]) {
    return rows.map((row, index) => {
      const record: Recordable = { __idx: index }
      cols.forEach((col, i) => {
        record[col] = row[i]
      })
      return record
    })
  }

  let nodeSeq = 0

  function treeNodeOf(node: MetricTreeNode): any {
    nodeSeq += 1
    return {
      key: `n${nodeSeq}`,
      title: `${node.name}（${node.code}）`,
      type: node.type,
      valueText: node.value !== undefined && node.value !== null ? `= ${node.value}` : '',
      exprText: node.expr ? String(node.expr).slice(0, 60) : '',
      children: (node.children || []).map(treeNodeOf),
    }
  }

  // ===== 历史（审计）=====
  const logs = ref<MetricQueryLog[]>([])
  const logsLoading = ref(false)
  const logsLoaded = ref(false)
  const logPage = ref(1)
  const logTotal = ref(0)
  const logQuery = reactive({ keyword: '', status: undefined as string | undefined, userName: '' })

  const logColumns = [
    { title: '问题', dataIndex: 'question', key: 'question', ellipsis: true },
    { title: '提问人', dataIndex: 'userName', key: 'userName', width: 110 },
    { title: '结果', key: 'status', width: 110 },
    { title: '耗时(ms)', dataIndex: 'elapsedMs', key: 'elapsedMs', width: 90 },
    { title: '时间', key: 'createdAt', width: 170 },
    { title: '操作', key: 'action', width: 160 },
  ]

  const logPagination = computed(() => ({
    current: logPage.value,
    pageSize: 20,
    total: logTotal.value,
  }))

  async function loadLogs() {
    logsLoading.value = true
    try {
      const result = await getMetricLogsApi({
        keyword: logQuery.keyword || undefined,
        status: logQuery.status,
        userName: logQuery.userName || undefined,
        page: logPage.value,
        size: 20,
      })
      logs.value = result?.items || []
      logTotal.value = result?.total || 0
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '历史加载失败'))
    } finally {
      logsLoading.value = false
    }
  }

  function reAsk(record: MetricQueryLog) {
    activeTab.value = 'chat'
    ask(record.question)
  }

  async function handleToExample(record: MetricQueryLog) {
    try {
      await logToExampleApi(record.id)
      createMessage.success('已转为 few-shot 示例')
      loadLogs()
    } catch (error) {
      createMessage.error(getApiErrorMessage(error, '转示例失败（仅 admin）'))
    }
  }

  onMounted(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] || '').get('q')
    if (q) ask(q)
  })

  // 首次切到「历史」tab 时拉取审计日志（此前无加载入口，表格永远空）
  watch(activeTab, (tab) => {
    if (tab === 'history' && !logsLoaded.value) {
      logsLoaded.value = true
      loadLogs()
    }
  })
</script>

<style lang="less" scoped>
  .chat-area {
    .msg-list {
      height: 480px;
      overflow-y: auto;
      padding: 8px;
      background: #fafafa;
      border-radius: 6px;
    }

    .msg-row {
      display: flex;
      margin-bottom: 12px;

      &.user {
        justify-content: flex-end;
      }

      &.assistant {
        justify-content: flex-start;
      }
    }

    .bubble {
      max-width: 86%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
    }

    .user-bubble {
      background: #1677ff;
      color: #fff;
    }

    .ai-bubble {
      background: #fff;
      border: 1px solid #f0f0f0;
      width: 100%;
    }

    .big-value {
      font-size: 22px;
      font-weight: 600;
      color: #1677ff;
      margin-right: 8px;
    }

    .tree-box {
      background: #f6f8fa;
      border-radius: 6px;
      padding: 8px;

      .tree-title {
        font-size: 12px;
        color: #666;
        margin-bottom: 4px;
      }

      .node-value {
        color: #d46b08;
        font-weight: 600;
      }

      .expr-text {
        color: #999;
        font-size: 12px;
        font-family: Consolas, Monaco, monospace;
      }
    }

    .sql-block {
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      background: #f6f8fa;
      padding: 8px 12px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-all;
    }
  }
</style>
