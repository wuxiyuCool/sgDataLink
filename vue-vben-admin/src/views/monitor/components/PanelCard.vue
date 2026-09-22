<template>
  <Card :bordered="false" size="small" class="dash-card" :class="{ 'dash-card--alert': !!error }">
    <template #title>
      <span class="dash-card__title">
        <Icon v-if="icon" :icon="icon" :color="iconColor" class="dash-card__icon" />
        <span>{{ title }}</span>
        <Tooltip v-if="hint" :title="hint">
          <Icon icon="ant-design:info-circle-outlined" class="dash-card__hint" />
        </Tooltip>
      </span>
    </template>
    <template #extra>
      <slot name="extra"></slot>
    </template>

    <!-- 单卡失败只影响本卡：错误态就地展示，不影响整页其它区块 -->
    <Alert v-if="error" type="error" show-icon :message="`${title}加载失败`" :description="error" />
    <Skeleton v-else-if="loading && skeleton" active :paragraph="{ rows: skeletonRows }" />
    <!-- 图表容器用 v-show 保活：ECharts 初始化依赖真实高度，v-if 会让 setOptions 一直空转 -->
    <div v-show="!error && !(loading && skeleton)" class="dash-card__body" :style="bodyStyle">
      <slot></slot>
    </div>
  </Card>
</template>

<script lang="ts" setup>
  import type { CSSProperties, PropType } from 'vue'
  import { Alert, Card, Skeleton, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'

  defineProps({
    title: { type: String, required: true },
    /** 标题左侧图标（ant-design:xxx-outlined） */
    icon: { type: String, default: '' },
    iconColor: { type: String, default: '' },
    /** 标题后的问号提示 */
    hint: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    /** 该卡专属错误文案（接口失败时只让本卡变错误态） */
    error: { type: String, default: '' },
    /** 首屏是否用骨架占位；纯文卡片可以关掉直接渲染兜底值 */
    skeleton: { type: Boolean, default: true },
    skeletonRows: { type: Number, default: 4 },
    bodyStyle: { type: Object as PropType<CSSProperties>, default: undefined },
  })
</script>

<style lang="less" scoped>
  .dash-card {
    height: 100%;

    &--alert {
      border-color: fade(#ff4d4f, 40%);
    }

    &__title {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 600;
    }

    &__icon {
      font-size: 15px;
    }

    &__hint {
      color: #8c8c8c;
      font-size: 13px;
      cursor: help;
    }

    &__body {
      width: 100%;
    }
  }
</style>
