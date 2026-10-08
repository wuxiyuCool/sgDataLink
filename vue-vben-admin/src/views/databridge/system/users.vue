<template>
  <PageWrapper
    title="用户管理"
    content="平台账号生命周期管理（契约 1.11，仅管理员可见）：新建/编辑/禁用/删除/重置密码；密码 bcrypt 哈希存储，任何界面不回显；不允许对当前登录账号执行禁用/降级/删除"
  >
    <Card :bordered="false">
      <Tabs v-model:activeKey="activeTab" @change="handleTabChange">
        <TabPane key="users" tab="用户列表">
          <Form :model="query" layout="inline" class="mb-3 gap-y-2" @finish="handleSearch">
            <FormItem label="关键字" name="keyword">
              <Input v-model:value="query.keyword" allow-clear placeholder="用户名或昵称" style="width: 180px" />
            </FormItem>
            <FormItem label="角色" name="role">
              <Select
                v-model:value="query.role"
                :options="ROLE_OPTIONS"
                allow-clear
                placeholder="全部"
                style="width: 120px"
              />
            </FormItem>
            <FormItem label="状态" name="status">
              <Select
                v-model:value="query.status"
                :options="STATUS_OPTIONS"
                allow-clear
                placeholder="全部"
                style="width: 120px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleReset">重置</Button>
              </Space>
            </FormItem>
          </Form>
          <div class="mb-3 flex justify-end">
            <Button type="primary" @click="openCreate">
              <Icon icon="ant-design:plus-outlined" class="mr-1" />
              新建用户
            </Button>
          </div>
          <Table
            :columns="userColumns"
            :data-source="dataSource"
            :loading="loading"
            :pagination="getPagination"
            row-key="id"
            size="middle"
            :scroll="{ x: 1000 }"
            @change="handleTableChange"
          >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'role'">
            <Tag :color="record.role === 'admin' ? 'geekblue' : 'default'">
              {{ record.role === 'admin' ? '管理员' : '普通用户' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag :color="record.status === 'active' ? 'success' : 'error'">
              {{ record.status === 'active' ? '启用' : '禁用' }}
            </Tag>
            <Tag v-if="record.mustChangePassword" color="warning">待改密</Tag>
          </template>
          <template v-else-if="column.key === 'docAccess'">
            <Tag :color="record.docAccess ? 'blue' : 'default'">
              {{ record.docAccess ? '已开通' : '未开通' }}
            </Tag>
          </template>
          <template v-else-if="column.key === 'lastLoginAt'">
            {{ formatTime(record.lastLoginAt) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <Space :size="0">
              <Button type="link" size="small" @click="openEdit(record)">编辑</Button>
              <Button type="link" size="small" @click="openReset(record)">重置密码</Button>
              <Popconfirm
                v-if="record.id !== currentUserId"
                :title="record.status === 'active' ? '确认禁用该账号？其登录 token 立即失效' : '确认启用该账号？'"
                @confirm="toggleStatus(record)"
              >
                <Button type="link" size="small">{{ record.status === 'active' ? '禁用' : '启用' }}</Button>
              </Popconfirm>
              <Popconfirm
                v-if="record.id !== currentUserId"
                title="确认删除该用户？其登录审计无法找回"
                @confirm="handleDelete(record)"
              >
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </Space>
          </template>
        </template>
          </Table>
        </TabPane>

        <TabPane key="loginlogs" tab="登录日志">
          <Alert
            class="mb-3"
            type="info"
            show-icon
            message="每次登录（成功与失败）都会记录：用户名/IP/结果/失败原因，滚动保留最近 1 万条；日志不含任何口令信息"
          />
          <Form layout="inline" class="mb-3 gap-y-2" @finish="handleLogSearch">
            <FormItem label="关键字" name="logKeyword">
              <Input v-model:value="logQuery.keyword" allow-clear placeholder="用户名或 IP" style="width: 170px" />
            </FormItem>
            <FormItem label="结果" name="logResult">
              <Select
                v-model:value="logQuery.result"
                :options="LOG_RESULT_OPTIONS"
                allow-clear
                placeholder="全部"
                style="width: 110px"
              />
            </FormItem>
            <FormItem label="时间" name="logRange">
              <RangePicker
                v-model:value="logRangeValue"
                show-time
                value-format="YYYY-MM-DD HH:mm:ss"
                :placeholder="['开始时间', '结束时间']"
                style="width: 350px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleLogReset">重置</Button>
              </Space>
            </FormItem>
          </Form>
          <Table
            :columns="logColumns"
            :data-source="logDataSource"
            :loading="logLoading"
            :pagination="logGetPagination"
            row-key="id"
            size="middle"
            :scroll="{ x: 800 }"
            @change="logHandleTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'createdAt'">
                {{ formatTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'ok'">
                <Tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? '成功' : '失败' }}</Tag>
              </template>
              <template v-else-if="column.key === 'errorMsg'">
                {{ record.errorMsg || '-' }}
              </template>
            </template>
          </Table>
        </TabPane>

        <TabPane key="doclogs" tab="文档访问日志">
          <Alert
            class="mb-3"
            type="info"
            show-icon
            message="GET /data-apis/swagger.json 每次访问（登录态 JWT 或文档 Key）都会记录，成败均含；key 只存掩码（前 6 位+***），完整 key 绝不落库；滚动保留最近 1 万条（契约 1.9.5）"
          />
          <Form layout="inline" class="mb-3 gap-y-2" @finish="handleDocLogSearch">
            <FormItem label="关键字" name="docKeyword">
              <Input v-model:value="docLogQuery.keyword" allow-clear placeholder="用户名或 IP" style="width: 170px" />
            </FormItem>
            <FormItem label="结果" name="docResult">
              <Select v-model:value="docLogQuery.result" :options="LOG_RESULT_OPTIONS" allow-clear placeholder="全部" style="width: 100px" />
            </FormItem>
            <FormItem label="方式" name="docAuthType">
              <Select v-model:value="docLogQuery.authType" :options="AUTH_TYPE_OPTIONS" allow-clear placeholder="全部" style="width: 110px" />
            </FormItem>
            <FormItem label="时间" name="docRange">
              <RangePicker
                v-model:value="docLogRangeValue"
                show-time
                value-format="YYYY-MM-DD HH:mm:ss"
                :placeholder="['开始时间', '结束时间']"
                style="width: 350px"
              />
            </FormItem>
            <FormItem>
              <Space>
                <Button type="primary" html-type="submit">查询</Button>
                <Button @click="handleDocLogReset">重置</Button>
              </Space>
            </FormItem>
          </Form>
          <Table
            :columns="docLogColumns"
            :data-source="docLogDataSource"
            :loading="docLogLoading"
            :pagination="docLogGetPagination"
            row-key="id"
            size="middle"
            :scroll="{ x: 1200 }"
            @change="docLogHandleTableChange"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'createdAt'">
                {{ formatTime(record.createdAt) }}
              </template>
              <template v-else-if="column.key === 'authType'">
                <Tag :color="record.authType === 'docKey' ? 'purple' : 'blue'">
                  {{ record.authType === 'docKey' ? '文档Key' : record.authType === 'jwt' ? '登录态' : '未认证' }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'keyMasked'">
                <span class="mono">{{ record.keyMasked || '-' }}</span>
              </template>
              <template v-else-if="column.key === 'ok'">
                <Tag :color="record.ok ? 'success' : 'error'">{{ record.ok ? '成功' : '失败' }}</Tag>
              </template>
              <template v-else-if="column.key === 'status'">
                <Space :size="4">
                  <Tag :color="record.ok ? 'success' : 'error'">{{ record.httpStatus ?? '-' }}</Tag>
                  <Tag v-if="record.bizCode" color="volcano">{{ record.bizCode }}</Tag>
                </Space>
              </template>
              <template v-else-if="column.key === 'errorMsg'">
                {{ record.errorMsg || '-' }}
              </template>
            </template>
          </Table>
        </TabPane>
      </Tabs>
    </Card>

    <!-- 新建 / 编辑共用一个弹窗，editRow 有值即编辑态 -->
    <Modal
      v-model:visible="formVisible"
      :title="editRow ? `编辑用户 · ${editRow.username}` : '新建用户'"
      :confirm-loading="formSubmitting"
      @ok="submitForm"
    >
      <Form ref="formRef" :model="formState" :rules="formRules" :label-col="{ span: 5 }" class="pt-4">
        <FormItem v-if="!editRow" label="用户名" name="username">
          <Input v-model:value="formState.username" placeholder="3~32 位小写字母/数字/._-" />
        </FormItem>
        <FormItem v-if="!editRow" label="初始密码" name="password">
          <Input.Password
            v-model:value="formState.password"
            placeholder="8~64 位，至少含 1 字母和 1 数字；用户首次登录须改密"
          />
        </FormItem>
        <FormItem label="昵称" name="nickname">
          <Input v-model:value="formState.nickname" placeholder="留空默认与用户名相同" />
        </FormItem>
        <FormItem label="角色" name="role">
          <Select v-model:value="formState.role" :options="ROLE_OPTIONS" :disabled="editRow?.id === currentUserId" />
        </FormItem>
        <FormItem v-if="editRow" label="状态" name="status">
          <Select
            v-model:value="formState.status"
            :options="STATUS_OPTIONS"
            :disabled="editRow.id === currentUserId"
          />
        </FormItem>
        <FormItem v-if="editRow" label="文档中心访问" name="docAccess">
          <Switch v-model:checked="formState.docAccess" />
          <div class="mt-1 text-gray-500">
            开通后自动为该用户生成个人文档 Key（本人可在文档中心页查看/刷新，用于免登录拉取
            swagger.json）；关闭权限或禁用账号，key 立即作废
          </div>
        </FormItem>
        <FormItem v-if="editRow" label="问数权限" name="chatAccess">
          <Switch v-model:checked="formState.chatAccess" />
          <div class="mt-1 text-gray-500" style="font-size: 12px">
            开通即自动为该用户生成问数 Key（X-CHAT-KEY 调用 /api/v1/chat/ask），本人到文档中心页查看/刷新；
            关闭权限 Key 立即失效。问数调用日志仅管理员可见。
          </div>
        </FormItem>
      </Form>
    </Modal>

    <Modal
      v-model:visible="resetVisible"
      :title="`重置密码 · ${resetRow?.username || ''}`"
      :confirm-loading="resetSubmitting"
      @ok="submitReset"
    >
      <Alert
        class="mb-3"
        type="warning"
        show-icon
        message="重置后需把新密码线下告知本人，用户下次登录会被强制再次修改"
      />
      <Form ref="resetFormRef" :model="resetState" :rules="resetRules" :label-col="{ span: 6 }">
        <FormItem label="新密码" name="password">
          <Input.Password v-model:value="resetState.password" placeholder="8~64 位，字母+数字" />
        </FormItem>
      </Form>
    </Modal>
  </PageWrapper>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive, ref } from 'vue'

  import {
    Alert,
    Button,
    Card,
    DatePicker,
    Form,
    Input,
    Modal,
    Popconfirm,
    Select,
    Space,
    Switch,
    Table,
    Tabs,
    Tag,
  } from 'ant-design-vue'

  import { Icon } from '/@/components/Icon'
  import { PageWrapper } from '/@/components/Page'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { useUserStore } from '/@/store/modules/user'
  import {
    createPlatformUserApi,
    deletePlatformUserApi,
    getPlatformUsersApi,
    resetPlatformUserPasswordApi,
    updatePlatformUserApi,
  } from '/@/api/databridge/user'
  import { getLoginLogsApi, getSwaggerLogsApi } from '/@/api/databridge/user'
  import type { DocAccessLogItem, LoginLogItem, PlatformUser } from '/@/api/databridge/user'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import { usePagedFetch } from '../hooks/usePagedFetch'
  import { formatTime } from '../data'

  const FormItem = Form.Item
  const RangePicker = DatePicker.RangePicker
  const TabPane = Tabs.TabPane

  const { createMessage } = useMessage()
  const userStore = useUserStore()
  const currentUserId = computed(() => String(userStore.getUserInfo?.userId ?? ''))

  const ROLE_OPTIONS = [
    { label: '管理员', value: 'admin' },
    { label: '普通用户', value: 'user' },
  ]
  const STATUS_OPTIONS = [
    { label: '启用', value: 'active' },
    { label: '禁用', value: 'disabled' },
  ]

  const userColumns = [
    { title: '用户名', dataIndex: 'username', width: 140 },
    { title: '昵称', dataIndex: 'nickname', width: 140, customRender: ({ text }) => text || '-' },
    { title: '角色', key: 'role', dataIndex: 'role', width: 110 },
    { title: '状态', key: 'status', dataIndex: 'status', width: 140 },
    { title: '文档权限', key: 'docAccess', dataIndex: 'docAccess', width: 90 },
    { title: '问数权限', key: 'chatAccess', dataIndex: 'chatAccess', width: 90 },
    { title: '最近登录', key: 'lastLoginAt', dataIndex: 'lastLoginAt', width: 170 },
    { title: '创建时间', dataIndex: 'createdAt', width: 170, customRender: ({ text }) => formatTime(text) },
    { title: '操作', key: 'action', width: 260, fixed: 'right' },
  ]

  const query = reactive<{ keyword?: string; role?: string; status?: string }>({})
  const { dataSource, loading, getPagination, fetch, handleTableChange } = usePagedFetch<PlatformUser>(
    getPlatformUsersApi,
    computed(() => ({
      keyword: query.keyword || undefined,
      role: query.role || undefined,
      status: query.status || undefined,
    })) as unknown as Recordable,
  )

  function handleSearch() {
    fetch()
  }
  function handleReset() {
    query.keyword = undefined
    query.role = undefined
    query.status = undefined
    fetch()
  }

  /** ---- 登录日志（契约 1.11 审计，首次切到页签才拉取） ---- */
  const activeTab = ref('users')
  const logLoaded = ref(false)
  const logQuery = reactive<{ keyword?: string; result?: 'success' | 'error' }>({})
  const logRangeValue = ref<[string, string] | undefined>(undefined)

  const LOG_RESULT_OPTIONS = [
    { label: '成功', value: 'success' },
    { label: '失败', value: 'error' },
  ]
  const logColumns = [
    { title: '时间', key: 'createdAt', dataIndex: 'createdAt', width: 180 },
    { title: '用户名', dataIndex: 'username', width: 150 },
    { title: '来源 IP', dataIndex: 'ip', width: 150 },
    { title: '结果', key: 'ok', dataIndex: 'ok', width: 90 },
    { title: '失败原因', key: 'errorMsg', dataIndex: 'errorMsg' },
  ]

  const {
    dataSource: logDataSource,
    loading: logLoading,
    getPagination: logGetPagination,
    fetch: fetchLogs,
    handleTableChange: logHandleTableChange,
  } = usePagedFetch<LoginLogItem>(
    getLoginLogsApi,
    computed(() => ({
      keyword: logQuery.keyword || undefined,
      result: logQuery.result || undefined,
      startTime: logRangeValue.value?.[0] || undefined,
      endTime: logRangeValue.value?.[1] || undefined,
    })) as unknown as Recordable,
  )

  function handleTabChange(key: string) {
    if (key === 'loginlogs' && !logLoaded.value) {
      logLoaded.value = true
      fetchLogs()
    }
    if (key === 'doclogs' && !docLogLoaded.value) {
      docLogLoaded.value = true
      fetchDocLogs()
    }
  }
  function handleLogSearch() {
    fetchLogs()
  }
  function handleLogReset() {
    logQuery.keyword = undefined
    logQuery.result = undefined
    logRangeValue.value = undefined
    fetchLogs()
  }

  /** ---- 文档访问日志（契约 1.9.5，首次切到页签才拉取） ---- */
  const docLogLoaded = ref(false)
  const docLogQuery = reactive<{ keyword?: string; result?: 'success' | 'error'; authType?: 'jwt' | 'docKey' }>({})
  const docLogRangeValue = ref<[string, string] | undefined>(undefined)

  const AUTH_TYPE_OPTIONS = [
    { label: '登录态 JWT', value: 'jwt' },
    { label: '文档 Key', value: 'docKey' },
  ]
  const docLogColumns = [
    { title: '时间', key: 'createdAt', dataIndex: 'createdAt', width: 170 },
    { title: '用户名', dataIndex: 'username', width: 130 },
    { title: '方式', key: 'authType', dataIndex: 'authType', width: 100 },
    { title: 'Key 掩码', key: 'keyMasked', dataIndex: 'keyMasked', width: 120 },
    { title: '来源 IP', dataIndex: 'ip', width: 140 },
    { title: '结果', key: 'ok', dataIndex: 'ok', width: 80 },
    { title: '状态/业务码', key: 'status', width: 130 },
    { title: '查询词', dataIndex: 'keyword', width: 120, customRender: ({ text }) => text || '-' },
    { title: '失败原因', key: 'errorMsg', dataIndex: 'errorMsg' },
  ]

  const {
    dataSource: docLogDataSource,
    loading: docLogLoading,
    getPagination: docLogGetPagination,
    fetch: fetchDocLogs,
    handleTableChange: docLogHandleTableChange,
  } = usePagedFetch<DocAccessLogItem>(
    getSwaggerLogsApi,
    computed(() => ({
      keyword: docLogQuery.keyword || undefined,
      result: docLogQuery.result || undefined,
      authType: docLogQuery.authType || undefined,
      startTime: docLogRangeValue.value?.[0] || undefined,
      endTime: docLogRangeValue.value?.[1] || undefined,
    })) as unknown as Recordable,
  )

  function handleDocLogSearch() {
    fetchDocLogs()
  }
  function handleDocLogReset() {
    docLogQuery.keyword = undefined
    docLogQuery.result = undefined
    docLogQuery.authType = undefined
    docLogRangeValue.value = undefined
    fetchDocLogs()
  }

  /** ---- 新建 / 编辑 ---- */
  const formVisible = ref(false)
  const formSubmitting = ref(false)
  const formRef = ref()
  const editRow = ref<PlatformUser | null>(null)
  const formState = reactive({ username: '', nickname: '', password: '', role: 'user', status: 'active', docAccess: false, chatAccess: false })

  const PASSWORD_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d).{8,64}$/
  const formRules = computed(() => ({
    username: editRow.value
      ? []
      : [
          { required: true, message: '请输入用户名' },
          { pattern: /^[a-z0-9_.-]{3,32}$/, message: '3~32 位小写字母/数字/._-', trigger: 'blur' },
        ],
    password: editRow.value
      ? []
      : [
          { required: true, message: '请输入初始密码' },
          { pattern: PASSWORD_PATTERN, message: '8~64 位，至少含 1 字母和 1 数字', trigger: 'blur' },
        ],
    role: [{ required: true, message: '请选择角色' }],
  }))

  function openCreate() {
    editRow.value = null
    Object.assign(formState, { username: '', nickname: '', password: '', role: 'user', status: 'active', docAccess: false, chatAccess: false })
    formVisible.value = true
  }

  function openEdit(record: PlatformUser) {
    editRow.value = record
    Object.assign(formState, {
      username: record.username,
      nickname: record.nickname || '',
      password: '',
      role: record.role,
      status: record.status,
      docAccess: !!record.docAccess,
      chatAccess: !!record.chatAccess,
    })
    formVisible.value = true
  }

  async function submitForm() {
    try {
      await formRef.value.validate()
    } catch {
      return
    }
    formSubmitting.value = true
    try {
      if (editRow.value) {
        await updatePlatformUserApi(editRow.value.id, {
          nickname: formState.nickname || undefined,
          role: formState.role,
          status: formState.status,
          docAccess: formState.docAccess,
          chatAccess: formState.chatAccess,
        })
        createMessage.success('用户已更新')
      } else {
        await createPlatformUserApi({
          username: formState.username,
          nickname: formState.nickname || undefined,
          password: formState.password,
          role: formState.role,
        })
        createMessage.success('用户已创建（初始密码仅本次有效，用户首登须修改）')
      }
      formVisible.value = false
      fetch()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      formSubmitting.value = false
    }
  }

  async function toggleStatus(record: PlatformUser) {
    try {
      await updatePlatformUserApi(record.id, {
        status: record.status === 'active' ? 'disabled' : 'active',
      })
      createMessage.success('状态已更新')
      fetch()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '操作失败'))
    }
  }

  async function handleDelete(record: PlatformUser) {
    try {
      await deletePlatformUserApi(record.id)
      createMessage.success('用户已删除')
      fetch()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '删除失败'))
    }
  }

  /** ---- 重置密码 ---- */
  const resetVisible = ref(false)
  const resetSubmitting = ref(false)
  const resetFormRef = ref()
  const resetRow = ref<PlatformUser | null>(null)
  const resetState = reactive({ password: '' })
  const resetRules = {
    password: [
      { required: true, message: '请输入新密码' },
      { pattern: PASSWORD_PATTERN, message: '8~64 位，至少含 1 字母和 1 数字', trigger: 'blur' },
    ],
  }

  function openReset(record: PlatformUser) {
    resetRow.value = record
    resetState.password = ''
    resetVisible.value = true
  }

  async function submitReset() {
    try {
      await resetFormRef.value.validate()
    } catch {
      return
    }
    if (!resetRow.value) return
    resetSubmitting.value = true
    try {
      await resetPlatformUserPasswordApi(resetRow.value.id, resetState.password)
      createMessage.success('密码已重置，该用户下次登录须修改')
      resetVisible.value = false
      fetch()
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '重置失败'))
    } finally {
      resetSubmitting.value = false
    }
  }

  onMounted(fetch)
</script>

<style lang="less" scoped>
  .mono {
    font-family: consolas, monospace;
  }
</style>
