/**
 * 6 位 Quartz 子集 cron 匹配器 —— Node 内置调度器专用（docs/API.md 第 1.6 节）。
 *
 * 字段顺序固定为「秒 分 时 日 月 周」，每个字段支持的形式只有三种：
 *   `*`   任意值（不限制）
 *   `?`   Quartz 的「不指定」，语义等同 `*`（契约示例 `0 0 2 * * ?` 用在日/周位）
 *   数字  单点精确匹配，如 `30`；越界（分>59、时>23、日>31、月>12、周>7）视为非法
 * 其它形式（区间 `1-5`、列表 `1,3`、步长 `*\/5`、英文名 `MON`、空字段、字段数不是 6）
 * 一律判定为「不支持」：matchesCron 返回 false（不抛错，绝不误触发），
 * isSupportedCron 返回 false，供调度器打一条 WARN 提示运维改表达式。
 *
 * 星期的取值沿用 Quartz 习惯：1=周日 … 7=周六（同时兼容 0=周日）；
 * 其余字段按 UTC 取值，与契约「时间统一 ISO 8601（UTC）」一致。
 *
 * 纯函数、无依赖，便于单元测试（tests/unit/utils/cronMatcher.test.js 风格）。
 */

/** 每个字段的取值范围（dayOfWeek 用 Quartz 的 1~7，额外允许 0） */
const FIELDS = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
];

/** 单字段是否属于支持的形式：`*` | `?` | 纯数字（且在字段范围内） */
const isSupportedField = (spec, field) => {
  if (spec === '*' || spec === '?') return true;
  if (!/^\d+$/.test(spec)) return false;
  const num = Number(spec);
  return num >= field.min && num <= field.max;
};

/**
 * 解析 cron 表达式为 6 个字段；字段数不是 6 或含空段时返回 null。
 * @param {string} cron
 * @returns {string[]|null}
 */
const parseCron = (cron) => {
  if (typeof cron !== 'string') return null;
  const trimmed = cron.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== FIELDS.length) return null;
  return parts;
};

/** 单个字段是否命中当前值（不支持的形式一律不命中） */
const matchField = (spec, field, value) => {
  if (!isSupportedField(spec, field)) return false;
  if (spec === '*' || spec === '?') return true;
  return Number(spec) === value;
};

/**
 * 表达式是否整体可用（6 段且每段都属于支持的形式）。
 * @param {string} cron
 * @returns {boolean}
 */
const isSupportedCron = (cron) => {
  const parts = parseCron(cron);
  if (!parts) return false;
  return parts.every((spec, index) => isSupportedField(spec, FIELDS[index]));
};

/**
 * 给定 UTC 时间是否命中 cron（按秒对齐，调度器每秒调用一次）。
 * @param {string} cron 6 位 Quartz 子集表达式
 * @param {Date} [date] 判定时间，默认当前时间
 * @returns {boolean}
 */
const matchesCron = (cron, date = new Date()) => {
  const parts = parseCron(cron);
  if (!parts) return false;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;

  const jsDayOfWeek = date.getUTCDay(); // 0=周日
  // Quartz: 1=周日..7=周六；这里同时允许直接写 0=周日
  const quartzDayOfWeek = jsDayOfWeek === 0 ? 1 : jsDayOfWeek + 1;
  const values = [
    date.getUTCSeconds(),
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    jsDayOfWeek,
  ];

  return parts.every((spec, index) => {
    if (index !== FIELDS.length - 1) return matchField(spec, FIELDS[index], values[index]);
    // 周字段：先按 Quartz 取值比，再按 JS 取值比（0=周日），两者都不中才算不中
    if (spec === '*' || spec === '?') return isSupportedField(spec, FIELDS[index]);
    if (!isSupportedField(spec, FIELDS[index])) return false;
    const num = Number(spec);
    return num === quartzDayOfWeek || (num === 0 && jsDayOfWeek === 0);
  });
};

module.exports = {
  FIELDS,
  parseCron,
  isSupportedCron,
  matchesCron,
};
