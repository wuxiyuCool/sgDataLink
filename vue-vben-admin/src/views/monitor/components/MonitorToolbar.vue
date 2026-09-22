<template>
  <div class="monitor-toolbar">
    <Space :size="12" wrap>
      <!-- 页头左侧插槽：健康状态 / 计数 Tag / 当前追踪对象等本页专属信息 -->
      <slot></slot>
      <Tooltip v-if="hint" :title="hint">
        <span class="monitor-toolbar__updated">上次更新 {{ updated || '-' }}</span>
      </Tooltip>
    </Space>
    <Space :size="10" wrap>
      <span class="monitor-toolbar__rule">{{ rule }}</span>
      <span class="monitor-toolbar__label">{{ label }}</span>
      <Switch :checked="modelValue" @change="handleSwitchChange" />
      <Button :loading="loading" @click="emit('refresh')">
        <Icon icon="ant-design:reload-outlined" class="mr-1" />
        立即刷新
      </Button>
    </Space>
  </div>
</template>

<script lang="ts" setup>
  /**
   * 四个监控大屏页共用的页头工具条：轮询节奏说明 + 自动刷新总开关 + 立即刷新。
   * 统一在这里落地，避免四页各写一套样式导致间距/文案漂移。
   */
  import { Button, Space, Switch, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'

  defineProps({
    /** 本页轮询纪律文案，如「KPI 与图表 30s」 */
    rule: { type: String, default: '' },
    /** 最近一次成功取数的本地时间（HH:mm:ss） */
    updated: { type: String, default: '' },
    /** updated 的悬浮提示，一般放各区各自的更新时间 */
    hint: { type: String, default: '' },
    label: { type: String, default: '自动刷新' },
    /** 自动刷新总开关（关掉即停掉本页全部定时器） */
    modelValue: { type: Boolean, default: true },
    loading: { type: Boolean, default: false },
  })

  const emit = defineEmits(['update:modelValue', 'refresh'])

  function handleSwitchChange(checked: boolean) {
    emit('update:modelValue', checked)
  }
</script>

<style lang="less" scoped>
  .monitor-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;

    &__updated {
      color: #595959;
      font-variant-numeric: tabular-nums;
      cursor: default;
    }

    &__rule,
    &__label {
      color: #8c8c8c;
      font-size: 12px;
    }
  }
</style>
