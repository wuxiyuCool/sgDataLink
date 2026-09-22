<template>
  <Alert
    v-if="error"
    class="mb-3"
    type="error"
    show-icon
    closable
    message="数据服务调用统计加载失败"
    :description="error"
    @close="emit('dismissError')"
  />
  <Row v-else :gutter="[16, 16]">
    <Col v-for="card in cards" :key="card.key" :xs="12" :sm="12" :lg="6">
      <Card :bordered="false" size="small" class="call-card">
        <Skeleton v-if="loading && !stats" active :paragraph="{ rows: 2 }" :title="{ width: 90 }" />
        <template v-else>
          <div class="call-head">
            <Icon :icon="card.icon" :color="card.color" class="call-head__icon" />
            <Tooltip :title="card.tip">
              <span class="call-head__title">{{ card.title }}</span>
            </Tooltip>
          </div>
          <div class="call-value" :style="{ color: card.color }">
            {{ card.value }}
            <span v-if="card.suffix" class="call-value__suffix">{{ card.suffix }}</span>
          </div>
          <div class="call-sub">
            <template v-if="card.sub.length">
              <span
                v-for="(seg, index) in card.sub"
                :key="index"
                :style="seg.color ? { color: seg.color } : {}"
              >
                {{ seg.text }}{{ index === card.sub.length - 1 ? '' : ' ' }}
              </span>
            </template>
            <span v-else class="call-sub__empty">—</span>
          </div>
          <Progress
            v-if="card.bar !== undefined"
            class="call-bar"
            size="small"
            :percent="card.bar"
            :show-info="false"
            :stroke-color="card.color"
          />
        </template>
      </Card>
    </Col>
  </Row>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { Alert, Card, Col, Progress, Row, Skeleton, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import type { DataApiCallStats } from '/@/api/databridge/statistics'
  import { DASH_COLORS, formatMetric } from '../monitor.data'

  interface Segment {
    text: string
    color?: string
  }

  interface CallCard {
    key: string
    title: string
    /** 缺字段一律为 '-'：后端 dataApiCallStats 与本页同批交付，未上线时不能显示成 0 */
    value: string
    suffix?: string
    icon: string
    color: string
    tip: string
    sub: Segment[]
    bar?: number
  }

  const props = defineProps({
    stats: { type: Object as PropType<DataApiCallStats | null | undefined>, default: null },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  })

  const emit = defineEmits(['dismissError'])

  const ICONS = {
    total: 'ant-design:mobile-outlined',
    success: 'ant-design:check-circle-outlined',
    error: 'ant-design:close-circle-outlined',
    latency: 'ant-design:field-time-outlined',
  }

  /** 取数值字段，缺失/NaN 返回 null，交由调用方显示 '-' */
  function numOf(value?: number | null) {
    return value === undefined || value === null || Number.isNaN(Number(value))
      ? null
      : Number(value)
  }

  /** 占比文案：分母缺失或为 0 时给 '-'，不给 Infinity */
  function percentText(part: number | null, whole: number | null) {
    if (part === null || whole === null || whole <= 0) return '-'
    return `${((part / whole) * 100).toFixed(1)}%`
  }

  /** 延迟文案与全站一致：<1000ms 用 ms，否则用 s */
  function latencyText(ms: number | null) {
    if (ms === null) return '-'
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}` : `${ms.toFixed(ms < 10 ? 2 : 1)}`
  }

  function latencyUnit(ms: number | null) {
    if (ms === null) return ''
    return ms >= 1000 ? 's' : 'ms'
  }

  /** 错误率色阶：<1% 绿 / <5% 橙 / 其余红，无数据灰 */
  function errorRateColor(rate: number | null) {
    if (rate === null) return DASH_COLORS.neutral
    if (rate < 1) return DASH_COLORS.success
    if (rate < 5) return DASH_COLORS.warning
    return DASH_COLORS.failed
  }

  /** 平均延迟色阶：<=100ms 绿 / <=500ms 橙 / 其余红（与运行时 10s 超时相比只是提前预警） */
  function latencyColor(ms: number | null) {
    if (ms === null) return DASH_COLORS.neutral
    if (ms <= 100) return DASH_COLORS.success
    if (ms <= 500) return DASH_COLORS.warning
    return DASH_COLORS.failed
  }

  const cards = computed<CallCard[]>(() => {
    const stats = props.stats
    const total = numOf(stats?.total)
    const success = numOf(stats?.success)
    const error = numOf(stats?.error)
    const errorRate = numOf(stats?.errorRate)
    const avgLatency = numOf(stats?.avgLatencyMs)
    const todaySuccess = numOf(stats?.todaySuccess)
    const todayError = numOf(stats?.todayError)

    return [
      {
        key: 'total',
        title: '总调用次数',
        value: formatMetric(total),
        icon: ICONS.total,
        color: DASH_COLORS.running,
        tip: '口径：overview.dataApiCallStats.total，全部已发布服务的累计调用（含成功与失败）',
        sub: stats
          ? [
              { text: `今日成功 ${formatMetric(todaySuccess)}`, color: DASH_COLORS.success },
              { text: `今日错误 ${formatMetric(todayError)}`, color: DASH_COLORS.failed },
            ]
          : [],
      },
      {
        key: 'success',
        title: '成功调用',
        value: formatMetric(success),
        icon: ICONS.success,
        color: DASH_COLORS.success,
        tip: '口径：dataApiCallStats.success（运行时返回 code=0 的调用）',
        sub: [{ text: `成功率 ${percentText(success, total)}` }],
      },
      {
        key: 'error',
        title: '错误调用',
        value: formatMetric(error),
        icon: ICONS.error,
        color: errorRateColor(errorRate),
        tip: '口径：dataApiCallStats.error（401/403/429/404/502 等，含限流与 SQL 执行失败）',
        sub: [{ text: `错误率 ${errorRate === null ? '-' : `${errorRate.toFixed(1)}%`}` }],
        // 进度条直接表达错误率本身（0-100%），不做放大，避免视觉夸大
        bar: errorRate === null ? undefined : Math.min(Math.max(errorRate, 0), 100),
      },
      {
        key: 'latency',
        title: '平均延迟',
        value: latencyText(avgLatency),
        suffix: latencyUnit(avgLatency),
        icon: ICONS.latency,
        color: latencyColor(avgLatency),
        tip: '口径：dataApiCallStats.avgLatencyMs，运行时端点端到端耗时算术平均',
        sub: [
          { text: `错误率 ${errorRate === null ? '-' : `${errorRate.toFixed(1)}%`} · 阈值 5%` },
        ],
      },
    ]
  })
</script>

<style lang="less" scoped>
  .call-card {
    height: 100%;
    transition: box-shadow 0.2s;

    &:hover {
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.09);
    }
  }

  .call-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: #8c8c8c;
    font-size: 13px;

    &__icon {
      font-size: 15px;
    }

    &__title {
      cursor: default;
    }
  }

  .call-value {
    margin-top: 2px;
    font-size: 26px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 34px;

    &__suffix {
      font-size: 14px;
      font-weight: 400;
    }
  }

  .call-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8px;
    min-height: 20px;
    color: #8c8c8c;
    font-size: 12px;
    line-height: 20px;

    &__empty {
      color: #bfbfbf;
    }
  }

  .call-bar {
    margin-top: 2px;
  }
</style>
