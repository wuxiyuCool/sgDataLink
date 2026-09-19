/**
 * 数据服务（Data API）mock 行生成器 —— docs/API.md 第 1.9 节「Mock 行为」。
 *
 * 契约要求：按 tableName + fields 生成**确定性**伪随机行（同一 page 结果稳定），
 * 因此这里手写 mulberry32 PRNG（Node 内置能力，不引任何第三方依赖），
 * 种子 = hash(tableName|page|size)，同一入参永远得到同一批数据。
 *
 * 纯逻辑、无依赖（不碰 config / logger / 仓储），可直接单测。
 */

/** mulberry32：32bit 状态的极小 PRNG，返回 [0,1) 的连续随机数发生器 */
const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** FNV-1a 32bit 字符串哈希，用作 PRNG 种子 */
const hashString = (text) => {
  let hash = 0x811c9dc5;
  const str = String(text);
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** 'DECIMAL(18,2)' -> { base: 'DECIMAL', precision: 18, scale: 2 } */
const parseType = (type) => {
  const raw = String(type || '').trim().toUpperCase();
  const base = raw.split('(')[0].trim();
  const args = raw.match(/\(([^)]*)\)/);
  const nums = args ? args[1].split(',').map((item) => Number(item.trim())) : [];
  return {
    base,
    precision: Number.isFinite(nums[0]) ? nums[0] : null,
    scale: Number.isFinite(nums[1]) ? nums[1] : null,
  };
};

const INTEGER_BASES = [
  'INT',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'MEDIUMINT',
  'LONG',
  'INT8',
  'INT16',
  'INT32',
  'INT64',
];
const DECIMAL_BASES = ['DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT', 'DOUBLE', 'REAL', 'MONEY'];
const STRING_BASES = ['VARCHAR', 'VARCHAR2', 'CHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'CLOB', 'STRING'];
const DATE_BASES = ['DATE'];
const DATETIME_BASES = ['DATETIME', 'TIMESTAMP', 'TIME'];
const BOOLEAN_BASES = ['BOOLEAN', 'BOOL', 'BIT'];

/** 英文词库：拼出看起来像业务字段的字符串 */
const EN_WORDS = ['order', 'amount', 'customer', 'remark', 'invoice', 'batch', 'status', 'channel', 'coupon', 'warehouse'];
/** 中文字库：mock 字符串里混一点中文，方便肉眼分辨「这是假数据」 */
const CN_WORDS = ['订单', '客户', '仓库', '备注', '渠道', '优惠券', '结算', '已发货', '待审核', '华东大区'];

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const pickFrom = (list, rand) => list[Math.floor(rand() * list.length) % list.length];

/** 主键 / ID 语义的整数列：给连续的伪自增值，看起来像真主键 */
const integerValue = (rand, index, name) => {
  if (/ID$|^NO$|_ID$|^NUM/.test(String(name).toUpperCase())) return 100000 + index + Math.floor(rand() * 3);
  return Math.floor(rand() * 900000) + 1000;
};

/** 小数值：小数位取声明的 scale（缺省 2），整数位不超过 precision - scale，避免溢出列宽 */
const decimalValue = (rand, scale, precision) => {
  const digits = scale === null ? 2 : Math.min(Math.max(scale, 0), 6);
  const intDigits = precision ? Math.max(Math.min(precision - digits, 9), 1) : 6;
  const max = 10 ** intDigits;
  return Number((rand() * max).toFixed(digits));
};

const stringValue = (rand, name) => {
  const cn = pickFrom(CN_WORDS, rand);
  const en = pickFrom(EN_WORDS, rand);
  // 交替产出「纯英文串」与「中文+英文混合串」，两种都带随机后缀
  if (rand() < 0.5) {
    const suffix = Math.floor(rand() * 900 + 100);
    return `${en}-${Array.from({ length: 4 }, () => LETTERS[Math.floor(rand() * LETTERS.length)]).join('')}${suffix}`;
  }
  return `${cn}${String(name || '').slice(0, 2)}${Math.floor(rand() * 99)}`;
};

/** 以 2026-09-19T00:00:00Z 为基准往前随机若干天，产出 'YYYY-MM-DD HH:mm:ss' */
const dateValue = (rand, withTime) => {
  const base = Date.UTC(2026, 8, 19, 0, 0, 0);
  const offsetMs = Math.floor(rand() * 30 * 24 * 60 * 60 * 1000) + Math.floor(rand() * 86400) * 1000;
  const d = new Date(base - offsetMs);
  const pad = (num) => String(num).padStart(2, '0');
  const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${datePart} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : datePart;
};

/** 单个字段的 mock 值 */
const mockValue = (field, rand, index) => {
  const { base, precision, scale } = parseType(field && field.type);
  const name = (field && field.name) || 'COL';
  if (INTEGER_BASES.includes(base)) return integerValue(rand, index, name);
  // Oracle 的 NUMBER 不带精度时按整数，其它 DECIMAL/NUMERIC/NUMBER(p,s) 按声明的小数位
  if (DECIMAL_BASES.includes(base)) return decimalValue(rand, base === 'NUMBER' && scale === null ? 0 : scale, precision);
  if (DATE_BASES.includes(base)) return dateValue(rand, false);
  if (DATETIME_BASES.includes(base)) return dateValue(rand, true);
  if (BOOLEAN_BASES.includes(base)) return rand() < 0.5;
  if (STRING_BASES.includes(base) || base === '') return stringValue(rand, name);
  return stringValue(rand, name);
};

/**
 * 生成一页 mock 数据。
 * @param {Object} input { tableName, fields: [{name,type}], page, size }
 * @returns {{ fields: string[], rows: Array<Array>, total: number, page: number, size: number }}
 */
const generateRows = ({ tableName = '', fields = [], page = 1, size = 20 } = {}) => {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeSize = Math.min(Math.max(parseInt(size, 10) || 20, 1), 500);
  // 同一 tableName + page + size 恒定得到同一批数据（契约「同一 page 结果稳定」）
  const rand = mulberry32(hashString(`${tableName}|${safePage}|${safeSize}`));
  // 总行数按种子落在 30~90 之间（契约示例 57 左右）
  const total = 30 + Math.floor(rand() * 61);
  const names = fields.map((field) => (field && field.name ? String(field.name) : ''));

  const start = (safePage - 1) * safeSize;
  const rowCount = Math.max(Math.min(total - start, safeSize), 0);
  // 行内容只与 (page, size, 行号) 有关：重新生成同页时数据不变
  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    const rowRand = mulberry32(hashString(`${tableName}|${safePage}|${safeSize}|${i}`));
    rows.push(names.map((name, fieldIndex) => mockValue(fields[fieldIndex], rowRand, start + i)));
  }

  return { fields: names, rows, total, page: safePage, size: safeSize };
};

module.exports = {
  mulberry32,
  hashString,
  parseType,
  generateRows,
};
