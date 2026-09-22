<template>
  <Row :gutter="[16, 16]">
    <Col v-for="metric in PIPELINE_METRICS" :key="metric.key" :xs="12" :sm="12" :lg="6">
      <Card :bordered="false" size="small" class="metric-card">
        <Skeleton
          v-if="loading && !status"
          active
          :paragraph="{ rows: 2 }"
          :title="{ width: 90 }"
        />
        <template v-else>
          <div class="metric-head">
            <Icon :icon="metric.icon" :color="metric.color" class="metric-head__icon" />
            <Tooltip :title="metric.tip">
              <span class="metric-head__title">{{ metric.title }}</span>
            </Tooltip>
          </div>
          <div
            class="metric-value"
            :class="{ 'metric-value--text': metric.key === 'cdcPosition' }"
            :style="{ color: valueColor(metric.key) }"
          >
            <Tooltip v-if="metric.key === 'cdcPosition'" :title="textValue(status?.cdcPosition)">
              <span class="metric-value__ellipsis">{{ textValue(status?.cdcPosition) }}</span>
            </Tooltip>
            <template v-else>
              {{ numericValue(metric.key) }}
              <span v-if="unitOf(metric.key)" class="metric-value__suffix">
                {{ unitOf(metric.key) }}
              </span>
            </template>
          </div>
          <div class="metric-sub">{{ subText(metric.key) }}</div>
        </template>
      </Card>
    </Col>
  </Row>
</template>

<script lang="ts" setup>
  import { computed } from 'vue'
  import type { PropType } from 'vue'
  import { Card, Col, Row, Skeleton, Tooltip } from 'ant-design-vue'
  import { Icon } from '/@/components/Icon'
  import type { PipelineStatusResult } from '/@/api/databridge/model/pipelineModel'
  import {
    LAG_THRESHOLD_MS,
    formatLag,
    formatTime,
    isLagOverThreshold,
  } from '/@/views/databridge/data'
  import { DASH_COLORS, PIPELINE_METRICS, formatMetric } from '../monitor.data'
  import type { PipelineMetricMeta } from '../monitor.data'

  const props = defineProps({
    /** 最近一次 GET /pipelines/:id/status 的返回（3s 轮询） */
    status: { type: Object as PropType<PipelineStatusResult | null>, default: null },
    loading: { type: Boolean, default: false },
  })

  /** 停止的管道没有实时指标：一律显示 '-'，避免把 0 误读成「没有流量」 */
  const isRunning = computed(() => props.status?.status === 'running')
  const lagMs = computed(() => {
    const value = props.status?.lagMs
    return value === undefined || value === null || Number.isNaN(Number(value))
      ? null
      : Number(value)
  })

  function textValue(value?: string | null) {
    const text = String(value ?? '').trim()
    return text || '-'
  }

  function numericValue(key: PipelineMetricMeta['key']) {
    if (key === 'cdcPosition') return textValue(props.status?.cdcPosition)
    if (!isRunning.value) return '-'
    const status = props.status
    if (!status) return '-'
    if (key === 'currentQps') return formatMetric(status.currentQps)
    if (key === 'changeRows') return formatMetric(status.changeRows)
    return formatLag(status.lagMs)
  }

  function unitOf(key: PipelineMetricMeta['key']) {
    if (!isRunning.value) return ''
    if (key === 'currentQps') return 'ev/s'
    if (key === 'changeRows') return '行'
    return ''
  }

  function valueColor(key: PipelineMetricMeta['key']) {
    const meta = PIPELINE_METRICS.find((item) => item.key === key)
    if (key === 'lagMs' && isRunning.value && isLagOverThreshold(lagMs.value)) {
      return DASH_COLORS.failed
    }
    return isRunning.value ? meta?.color ?? DASH_COLORS.neutral : DASH_COLORS.neutral
  }

  function subText(key: PipelineMetricMeta['key']) {
    const status = props.status
    if (!status) return '等待首次状态轮询'
    if (key === 'currentQps') return isRunning.value ? '引擎回报 · 3s 轮询' : '管道已停止'
    if (key === 'lagMs') {
      if (!isRunning.value) return '管道已停止'
      return isLagOverThreshold(lagMs.value)
        ? `超阈值 ${LAG_THRESHOLD_MS}ms，请检查源库压力`
        : `阈值 ${LAG_THRESHOLD_MS}ms`
    }
    if (key === 'changeRows') {
      return status.startedAt ? `实例启动于 ${formatTime(status.startedAt)}` : '本实例启动以来累计'
    }
    return status.instanceId ? `实例 ${status.instanceId}` : '暂无运行实例'
  }
</script>

<style lang="less" scoped>
  .metric-card {
    height: 100%;
    transition: box-shadow 0.2s;

    &:hover {
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.09);
    }
  }

  .metric-head {
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

  .metric-value {
    margin-top: 2px;
    overflow: hidden;
    font-size: 26px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 34px;
    white-space: nowrap;

    &--text {
      font-family: monospace;
      font-size: 15px;
      line-height: 34px;
    }

    &__ellipsis {
      display: block;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    &__suffix {
      font-size: 14px;
      font-weight: 400;
    }
  }

  .metric-sub {
    min-height: 20px;
    overflow: hidden;
    color: #8c8c8c;
    font-size: 12px;
    line-height: 20px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
