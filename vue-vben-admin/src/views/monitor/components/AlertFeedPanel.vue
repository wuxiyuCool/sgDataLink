<template>
  <PanelCard
    title="最新告警"
    icon="ant-design:alert-outlined"
    hint="来自 GET /statistics/overview 的 recentAlerts（告警记录最新 8 条，契约 1.10）；点击未读条目会 PATCH /alert-records/:id/read 并刷新列表"
    :loading="loading"
    :error="error"
    :skeleton-rows="6"
  >
    <template #extra>
      <Space :size="8">
        <Tag v-if="unreadCount" color="error">未读 {{ unreadCount }}</Tag>
        <Button type="link" size="small" @click="goAlertPage">告警管理</Button>
      </Space>
    </template>

    <Empty v-if="!items.length" :description="DASH_EMPTY_TEXT.alerts">
      <Button size="small" @click="goAlertPage">配置告警规则</Button>
    </Empty>

    <ul v-else class="alert-feed">
      <li
        v-for="item in items"
        :key="item.id"
        class="alert-feed__item"
        :class="{ 'alert-feed__item--unread': !item.read }"
        :title="item.read ? item.message : '点击标记为已读'"
        @click="handleClick(item)"
      >
        <span class="alert-feed__dot" :style="{ backgroundColor: levelColor(item.level) }"></span>
        <div class="alert-feed__main">
          <div class="alert-feed__head">
            <Tag :color="levelTag(item.level)">{{ item.level }}</Tag>
            <span class="alert-feed__target">{{ item.targetName || '未命名对象' }}</span>
          </div>
          <div class="alert-feed__message">{{ item.message || '-' }}</div>
        </div>
        <span class="alert-feed__time">{{ formatTime(item.createdAt, 'MM-DD HH:mm:ss') }}</span>
      </li>
    </ul>
  </PanelCard>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { useRouter } from 'vue-router'
  import { Button, Empty, Space, Tag } from 'ant-design-vue'
  import { formatTime } from '/@/views/databridge/data'
  import type { RecentAlertItem } from '/@/api/databridge/statistics'
  import { DASH_EMPTY_TEXT, getLogLevelColor } from '../monitor.data'
  import PanelCard from './PanelCard.vue'

  const props = defineProps({
    items: { type: Array as PropType<RecentAlertItem[]>, default: () => [] },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const emit = defineEmits(['read'])

  const router = useRouter()

  const unreadCount = computed(() => (props.items || []).filter((item) => !item.read).length)

  function levelColor(level?: string) {
    return getLogLevelColor(level)
  }

  function levelTag(level?: string) {
    if (level === 'ERROR') return 'error'
    if (level === 'WARN') return 'warning'
    return 'processing'
  }

  function handleClick(item: RecentAlertItem) {
    if (item.read) return
    emit('read', item.id)
  }

  function goAlertPage() {
    router.push('/databridge/alert')
  }
</script>

<style lang="less" scoped>
  .alert-feed {
    max-height: 268px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;

    &__item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 6px;
      border-bottom: 1px dashed #f0f0f0;
      cursor: pointer;
      transition: background-color 0.2s;

      &:hover {
        background-color: rgba(24, 144, 255, 0.06);
      }

      &:last-child {
        border-bottom: none;
      }

      &--unread {
        .alert-feed__message,
        .alert-feed__target {
          font-weight: 600;
        }
      }
    }

    &__dot {
      flex: none;
      width: 8px;
      height: 8px;
      margin-top: 6px;
      border-radius: 50%;
    }

    &__main {
      flex: 1;
      min-width: 0;
    }

    &__head {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    &__target {
      overflow: hidden;
      color: #595959;
      font-size: 12px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    &__message {
      display: -webkit-box;
      overflow: hidden;
      font-size: 13px;
      line-height: 20px;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }

    &__time {
      flex: none;
      color: #8c8c8c;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
  }
</style>
