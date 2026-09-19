/**
 * 内存滑动窗口限流器 —— 数据服务运行时网关（docs/API.md 第 1.9 节）用。
 *
 * 契约口径：「限流用内存滑动窗口按 rateLimitQps 真实拦截」，窗口宽度 1s，
 * 同一 API 在窗口内已放行数达到 qps 即拒绝（429 / 42901）。
 * 这里做成「按 key 分桶 + 固定窗口重新计数」的最小实现：窗口时间戳前进一格就清零，
 * 因此最坏情况是相邻两个窗口各放行 qps 次（业界常见的固定/滑动近似），Mock 阶段足够。
 *
 * 纯逻辑、无依赖，时间由调用方注入（nowMs），便于单测。
 */

const DEFAULT_WINDOW_MS = 1000;

/**
 * @param {Object} [options] { windowMs: 1000 }
 * @returns {Object} { check, reset, size, clearAll }
 */
const createRateWindow = ({ windowMs = DEFAULT_WINDOW_MS } = {}) => {
  /** key -> { windowStart, count } */
  const buckets = new Map();

  /**
   * 消耗一次配额。
   * @param {string} key 限流桶（一般是 dataApi 的 id）
   * @param {number} limit 窗口内允许的次数（rateLimitQps），<=0 表示不限流
   * @param {number} nowMs 当前时间戳（毫秒）
   * @returns {{ allowed: boolean, count: number, retryAfterMs: number }}
   */
  const check = (key, limit, nowMs = Date.now()) => {
    const ceiling = Number(limit);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return { allowed: true, count: 0, retryAfterMs: 0 };

    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const bucket = buckets.get(key);
    // 跨窗口：整桶重置（等价于窗口滑动到下一格）
    if (!bucket || bucket.windowStart !== windowStart) {
      buckets.set(key, { windowStart, count: 1 });
      return { allowed: true, count: 1, retryAfterMs: 0 };
    }
    if (bucket.count >= ceiling) {
      return { allowed: false, count: bucket.count, retryAfterMs: windowStart + windowMs - nowMs };
    }
    bucket.count += 1;
    return { allowed: true, count: bucket.count, retryAfterMs: 0 };
  };

  return {
    check,
    reset: (key) => buckets.delete(key),
    size: () => buckets.size,
    clearAll: () => buckets.clear(),
  };
};

module.exports = {
  DEFAULT_WINDOW_MS,
  createRateWindow,
};
