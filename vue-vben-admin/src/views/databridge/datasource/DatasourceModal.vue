<template>
  <BasicModal
    v-bind="$attrs"
    @register="registerModal"
    :title="isUpdate ? '编辑数据源' : '新增数据源'"
    :width="680"
    :min-height="300"
    :mask-closable="false"
    :confirm-loading="submitting"
    @ok="handleSubmit"
  >
    <Form
      ref="formRef"
      :model="formState"
      :rules="getRules"
      :label-col="{ span: 6 }"
      :wrapper-col="{ span: 16 }"
    >
      <FormItem label="数据源名称" name="name">
        <Input v-model:value="formState.name" placeholder="例如：生产Oracle（名称含 fail 时 mock 连通测试必然失败）" />
      </FormItem>
      <FormItem label="类型" name="type">
        <Select
          v-model:value="formState.type"
          :options="DATASOURCE_TYPE_OPTIONS"
          placeholder="请选择数据源类型"
          @change="handleTypeChange"
        />
      </FormItem>
      <FormItem label="主机地址" name="host">
        <Input v-model:value="formState.host" placeholder="例如：10.0.0.11（以 10. 开头 mock 连通测试必然失败）" />
      </FormItem>
      <FormItem label="端口" name="port">
        <InputNumber v-model:value="formState.port" :min="1" :max="65535" style="width: 100%" />
      </FormItem>
      <FormItem label="数据库/服务名" name="database">
        <Input v-model:value="formState.database" placeholder="Oracle 填服务名，如 ORCLPDB1" />
      </FormItem>
      <FormItem label="用户名" name="username">
        <Input v-model:value="formState.username" placeholder="连接用户名" />
      </FormItem>
      <FormItem label="密码" name="password">
        <InputPassword
          v-model:value="formState.password"
          :placeholder="isUpdate ? '留空表示不修改' : '连接密码'"
          autocomplete="new-password"
        />
      </FormItem>
      <FormItem label="状态" name="status">
        <Select v-model:value="formState.status" :options="DATASOURCE_STATUS_OPTIONS" />
      </FormItem>
      <FormItem label="备注" name="remark">
        <TextArea v-model:value="formState.remark" :rows="2" placeholder="选填" />
      </FormItem>
    </Form>

    <template #insertFooter>
      <Button class="float-left" :loading="testing" @click="handleTest">连通性测试</Button>
    </template>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { computed, reactive, ref, unref } from 'vue'
  import { Button, Form, Input, InputNumber, Select } from 'ant-design-vue'
  import { BasicModal, useModalInner } from '/@/components/Modal'
  import { useMessage } from '/@/hooks/web/useMessage'
  import { createDatasourceApi, testDatasourceApi, updateDatasourceApi } from '/@/api/databridge/datasource'
  import { getApiErrorMessage } from '/@/api/databridge/http'
  import type {
    Datasource,
    DatasourceTestResult,
    DatasourceType,
  } from '/@/api/databridge/model/datasourceModel'
  import {
    DATASOURCE_DEFAULT_PORT,
    DATASOURCE_STATUS_OPTIONS,
    DATASOURCE_TYPE_OPTIONS,
  } from '../data'

  const FormItem = Form.Item
  const TextArea = Input.TextArea
  const InputPassword = Input.Password

  const emit = defineEmits(['register', 'success'])
  const { createMessage } = useMessage()

  const formRef = ref()
  const isUpdate = ref(false)
  const submitting = ref(false)
  const testing = ref(false)

  const defaultForm: Datasource = {
    id: undefined,
    name: '',
    type: 'oracle',
    host: '',
    port: DATASOURCE_DEFAULT_PORT.oracle,
    database: '',
    username: '',
    password: '',
    remark: '',
    status: 'enabled',
  }

  const formState = reactive<Datasource>({ ...defaultForm })

  const baseRules: Record<string, any> = {
    name: [{ required: true, message: '请输入数据源名称', trigger: 'blur' }],
    type: [{ required: true, message: '请选择数据源类型', trigger: 'change' }],
    host: [{ required: true, message: '请输入主机地址', trigger: 'blur' }],
    port: [
      { required: true, type: 'number', message: '请输入端口', trigger: 'change' },
    ],
    database: [{ required: true, message: '请输入数据库/服务名', trigger: 'blur' }],
    username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
    password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  }

  const getRules = computed(() => {
    if (!unref(isUpdate)) return baseRules
    // 编辑时后端返回的 password 永远是 "***"，留空表示不修改
    return { ...baseRules, password: [] }
  })

  const [registerModal, { setModalProps, closeModal }] = useModalInner(async (data) => {
    isUpdate.value = !!data?.isUpdate
    Object.assign(formState, defaultForm)
    if (data?.record) {
      Object.assign(formState, data.record)
      formState.password = ''
    }
    setModalProps({ confirmLoading: false })
    formRef.value?.clearValidate?.()
  })

  function handleTypeChange(value: DatasourceType) {
    if (!unref(isUpdate)) {
      formState.port = DATASOURCE_DEFAULT_PORT[value] || formState.port
    }
  }

  function buildPayload(): Datasource {
    const payload: Datasource = {
      name: formState.name,
      type: formState.type,
      host: formState.host,
      port: Number(formState.port),
      database: formState.database,
      username: formState.username,
      remark: formState.remark,
      status: formState.status,
    }
    // 密码留空表示沿用原值（响应体中后端永远脱敏为 "***"）
    if (formState.password && formState.password !== '***') {
      payload.password = formState.password
    }
    if (unref(isUpdate) && formState.id) {
      payload.id = formState.id
    }
    return payload
  }

  async function validateForm(): Promise<boolean> {
    if (!formRef.value) return true
    try {
      await formRef.value.validate()
      return true
    } catch {
      return false
    }
  }

  async function handleTest() {
    if (!(await validateForm())) return
    testing.value = true
    try {
      const result: DatasourceTestResult | any = await testDatasourceApi(buildPayload())
      if (result?.success) {
        createMessage.success(`连通测试成功，耗时 ${result.latencyMs ?? '-'} ms：${result.message || ''}`)
      } else {
        createMessage.error(`连通测试失败：${result?.message || '未知原因'}`)
      }
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '连通测试请求失败'))
    } finally {
      testing.value = false
    }
  }

  async function handleSubmit() {
    if (!(await validateForm())) return
    submitting.value = true
    setModalProps({ confirmLoading: true })
    try {
      const payload = buildPayload()
      if (unref(isUpdate) && payload.id) {
        await updateDatasourceApi(payload.id, payload)
        createMessage.success('数据源已更新')
      } else {
        await createDatasourceApi(payload)
        createMessage.success('数据源已新增')
      }
      closeModal()
      emit('success')
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '保存失败'))
    } finally {
      submitting.value = false
      setModalProps({ confirmLoading: false })
    }
  }
</script>
