<template>
  <Modal
    :visible="visible"
    :title="forced ? '首次登录 / 密码被重置，请先修改密码' : '修改密码'"
    :closable="!forced"
    :maskClosable="false"
    :keyboard="false"
    :confirm-loading="submitting"
    ok-text="确认修改"
    :cancel-text="forced ? '稍后通过头像菜单修改' : '取消'"
    @ok="submit"
    @cancel="close"
  >
    <Alert
      v-if="!forced"
      class="mb-3"
      type="info"
      show-icon
      message="修改成功后当前会话继续有效；他人无法通过任何接口看到你的密码"
    />
    <Form ref="formRef" :model="form" :rules="rules" :label-col="{ span: 6 }">
      <FormItem label="旧密码" name="oldPassword">
        <Input.Password v-model:value="form.oldPassword" placeholder="当前使用的密码" />
      </FormItem>
      <FormItem label="新密码" name="newPassword">
        <Input.Password v-model:value="form.newPassword" placeholder="8~64 位，至少含 1 字母和 1 数字" />
      </FormItem>
      <FormItem label="确认新密码" name="confirmPassword">
        <Input.Password v-model:value="form.confirmPassword" placeholder="再输入一次" />
      </FormItem>
    </Form>
  </Modal>
</template>

<script lang="ts" setup>
  import { reactive, ref } from 'vue'

  import { Alert, Form, Input, Modal } from 'ant-design-vue'

  import { useMessage } from '/@/hooks/web/useMessage'
  import { useUserStore } from '/@/store/modules/user'
  import { changePasswordApi } from '/@/api/sys/user'
  import { getApiErrorMessage } from '/@/api/databridge/http'

  const FormItem = Form.Item

  const props = defineProps<{ visible: boolean; forced?: boolean }>()
  const emit = defineEmits<{ (e: 'update:visible', v: boolean): void }>()

  const { createMessage } = useMessage()
  const userStore = useUserStore()
  const formRef = ref()
  const submitting = ref(false)
  const form = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

  const PASSWORD_PATTERN = /^(?=.*[a-zA-Z])(?=.*\d).{8,64}$/
  const rules = {
    oldPassword: [{ required: true, message: '请输入旧密码' }],
    newPassword: [
      { required: true, message: '请输入新密码' },
      { pattern: PASSWORD_PATTERN, message: '8~64 位，至少含 1 字母和 1 数字', trigger: 'blur' },
    ],
    confirmPassword: [
      { required: true, message: '请再次输入新密码' },
      {
        validator: (_r: any, value: string) =>
          value && value !== form.newPassword
            ? Promise.reject(new Error('两次输入的新密码不一致'))
            : Promise.resolve(),
        trigger: 'blur',
      },
    ],
  }

  function close() {
    // forced 模式不允许关闭（点取消仅收起弹窗输入，登录后仍会再次弹出）
    if (props.forced) {
      userStore.setUserInfo({ ...(userStore.getUserInfo as any), mustChangePassword: false })
    }
    emit('update:visible', false)
  }

  async function submit() {
    try {
      await formRef.value.validate()
    } catch {
      return
    }
    submitting.value = true
    try {
      await changePasswordApi(form.oldPassword, form.newPassword)
      createMessage.success('密码已修改')
      userStore.setUserInfo({ ...(userStore.getUserInfo as any), mustChangePassword: false })
      emit('update:visible', false)
    } catch (error: any) {
      createMessage.error(getApiErrorMessage(error, '修改失败'))
    } finally {
      submitting.value = false
    }
  }
</script>
