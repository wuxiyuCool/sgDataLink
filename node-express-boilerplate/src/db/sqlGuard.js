/**
 * 自定义 SQL 安全闸（docs/API.md 1.9.2「安全红线」）。
 *
 * 纯函数、零依赖、可单测：不 require 任何模块（含 config / logger / bizError），
 * 因此既能被 src/db/dataQuery.js 在真正下发 SQL 前兜底调用，也能直接跑断言脚本。
 *
 * 四条红线里由本模块负责的：
 *   1) 规范化后必须以 SELECT / WITH 开头；去尾分号后仍含分号（字符串字面量外的）即拒；
 *   2) 关键字黑名单按**词边界**匹配（大小写不敏感），且匹配前先屏蔽字符串字面量与注释，
 *      避免 `WHERE remark = 'DELETE FROM t'` 这类误杀，也避免 `-- ; DROP` 这类漏判；
 *      UNION 允许（仍为只读）；
 *   3) list 参数元素上限 1000（Oracle IN 列表限制），空列表按参数错误抛；
 *   4) 参数值一律走绑定，本模块只提供占位符解析与改写，绝不参与值拼接。
 *
 * 屏蔽实现细节：maskLiteralsAndComments() 产出「与原文等长、字面量/注释替换为空格」的掩码串，
 * 在掩码串上跑正则得到的下标可直接用于改写原文，两套解析（只读校验 / 占位符提取）共用同一份词法。
 */

/** 黑名单关键字（词边界、大小写不敏感）。UNION 刻意不在列：只读查询里合法且常见。 */
const BLOCKED_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'EXECUTE',
  'CALL',
  'BEGIN',
  'LOCK',
  'RENAME',
];

/** 只允许 SELECT / WITH（CTE）开头 */
const READ_ONLY_HEAD_RE = /^(SELECT|WITH)\b/i;
/** list 展开后的元素占位符后缀（:orgIds__0），与契约 1.9.2 的命名保持一致 */
const LIST_ITEM_SUFFIX = '__';
/** list 参数元素上限（Oracle 单条 IN 列表 1000 项硬限制） */
const MAX_LIST_ITEMS = 1000;
/** customSql 长度上限，防把超大文本塞进 JSON 列 */
const MAX_SQL_LENGTH = 20000;

/** 参数类错误：带上 bizCode/statusCode，交给 middlewares/error.js 直接渲染成 40001/400 */
class SqlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlGuardError';
    this.bizCode = 40001;
    this.statusCode = 400;
  }
}

/** 词边界 + 大小写不敏感的黑名单（写成字面量，避免运行期拼正则） */
const BLOCKED_RE =
  /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|MERGE|EXECUTE|CALL|BEGIN|LOCK|RENAME)\b/i;

const isQuoteChar = (ch) => ch === "'" || ch === '"' || ch === '`';

/**
 * 把字符串字面量 / 带引号标识符 / 注释（`--`、`#`、`/* *\/`）替换成等长空格，
 * 其余字符原样保留 —— 长度不变，所以掩码串上匹配到的下标可以直接用于改写原文。
 * @param {string} sql
 * @returns {string}
 */
const maskLiteralsAndComments = (sql) => {
  const text = String(sql);
  const out = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    // 行注释：-- 到行尾（保留换行，避免把下一行并进掩码）
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (ch === '#') {
      // MySQL 的行注释（Oracle 里 # 不是注释符，按注释处理只会更保守）
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (isQuoteChar(ch)) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2; // 反斜杠转义（MySQL 默认开启）
        } else if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2; // '' 双写转义（Oracle / 标准 SQL）
          else break;
        } else {
          j += 1;
        }
      }
      blank(i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
    } else {
      i += 1;
    }
  }
  return out.join('');
};

/**
 * 规范化：trim + 去结尾分号（含 `; ;` 这类连续尾巴与尾随空白）。
 * @param {string} sql
 * @returns {string}
 */
const normalizeSql = (sql) =>
  String(sql === undefined || sql === null ? '' : sql)
    .trim()
    .replace(/;(\s*;)*\s*$/g, '')
    .trim();

/**
 * 只读校验：去注释/屏蔽字面量后必须 SELECT|WITH 开头、字面量外无分号、无黑名单关键字。
 * @param {string} sql
 * @returns {{ ok: boolean, reason: string|null }}
 */
const assertReadOnly = (sql) => {
  const normalized = normalizeSql(sql);
  if (!normalized) return { ok: false, reason: 'SQL 为空' };
  if (normalized.length > MAX_SQL_LENGTH) {
    return { ok: false, reason: `SQL 长度超过上限 ${MAX_SQL_LENGTH}` };
  }
  const masked = maskLiteralsAndComments(normalized);
  if (masked.includes(';')) return { ok: false, reason: '禁止多语句：SQL 中含分号' };
  if (!READ_ONLY_HEAD_RE.test(masked.trim())) {
    return { ok: false, reason: '只允许 SELECT / WITH 开头的只读查询' };
  }
  const hit = masked.match(BLOCKED_RE);
  if (hit) return { ok: false, reason: `SQL 含禁用关键字 ${String(hit[0]).toUpperCase()}` };
  return { ok: true, reason: null };
};

/**
 * 占位符匹配（在掩码串上跑，因此天然忽略字面量/注释里的冒号）。
 * 每次调用都新建正则实例，避免全局正则的 lastIndex 在跨调用间互相污染。
 * `:name` 规则：首字符字母或下划线，其后允许数字、下划线和 $（Oracle 绑定变量命名）。
 */
const matchPlaceholders = (masked) => {
  const re = /:([A-Za-z_][A-Za-z0-9_$]{0,63})/g;
  const found = [];
  let m = re.exec(masked);
  while (m) {
    found.push({ name: m[1], start: m.index, end: m.index + m[0].length });
    re.lastIndex = m.index + m[0].length;
    m = re.exec(masked);
  }
  return found;
};

/**
 * 提取 `:name` 占位符名（按首次出现顺序去重）。
 * @param {string} sql
 * @returns {string[]}
 */
const extractPlaceholders = (sql) => {
  const masked = maskLiteralsAndComments(String(sql === undefined || sql === null ? '' : sql));
  const seen = new Set();
  const names = [];
  matchPlaceholders(masked).forEach(({ name }) => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  return names;
};

/**
 * 反向改写：把 `:name` 按出现顺序替换成 mysql2 的 `?`。
 * @param {string} sql 已（或未）展开过 list 的 SQL
 * @param {string[]} [order] 已累积的绑定顺序；返回值里的 order 是其副本 + 本次顺序
 * @returns {{ sql: string, order: string[] }}
 */
const toMysqlPositional = (sql, order = []) => {
  const text = String(sql === undefined || sql === null ? '' : sql);
  const masked = maskLiteralsAndComments(text);
  const found = matchPlaceholders(masked);
  const names = Array.isArray(order) ? order.slice() : [];
  let out = '';
  let cursor = 0;
  found.forEach(({ name, start, end }) => {
    out += text.slice(cursor, start) + '?';
    names.push(name);
    cursor = end;
  });
  out += text.slice(cursor);
  return { sql: out, order: names };
};

/**
 * list 参数展开：`:orgIds` → `:orgIds__0, :orgIds__1, ...`（oracle 原生绑定名；mysql 再转 `?`）。
 * 从右往左替换，保证左侧占位符下标仍然有效。
 * @param {string} sql
 * @param {Object<string, number>} listSizes 占位符名 -> 元素个数
 * @returns {{ sql: string, expanded: Array<{name:string, itemNames:string[]}> }}
 */
const expandListPlaceholders = (sql, listSizes = {}) => {
  const text = String(sql === undefined || sql === null ? '' : sql);
  const masked = maskLiteralsAndComments(text);
  const entries = Object.entries(listSizes || {});
  if (!entries.length) return { sql: text, expanded: [] };
  const sizes = new Map(entries.map(([name, size]) => [name, Number(size) || 0]));
  const found = matchPlaceholders(masked).filter(({ name }) => sizes.has(name));
  const expanded = new Map();
  let out = text;
  for (let k = found.length - 1; k >= 0; k -= 1) {
    const { name, start, end } = found[k];
    const size = sizes.get(name);
    if (!expanded.has(name)) {
      expanded.set(name, Array.from({ length: size }, (_, idx) => `${name}${LIST_ITEM_SUFFIX}${idx}`));
    }
    const replacement = expanded.get(name).map((item) => `:${item}`).join(', ');
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return { sql: out, expanded: Array.from(expanded, ([name, itemNames]) => ({ name, itemNames })) };
};

/** list 元素名 → 原参数名（:orgIds__3 → orgIds）；非展开名返回 null */
const listItemOf = (name) => {
  const text = String(name);
  const at = text.lastIndexOf(LIST_ITEM_SUFFIX);
  if (at <= 0) return null;
  const idx = text.slice(at + LIST_ITEM_SUFFIX.length);
  return /^\d+$/.test(idx) ? { name: text.slice(0, at), index: Number(idx) } : null;
};

/** 数组化：契约允许「逗号分隔字符串」或「重复 query 参数」两种写法 */
const toList = (raw) => {
  const parts = Array.isArray(raw)
    ? raw.reduce((acc, item) => acc.concat(String(item).split(',')), [])
    : String(raw).split(',');
  const items = parts.map((item) => String(item).trim()).filter((item) => item !== '');
  if (!items.length) throw new SqlGuardError('list 参数不能为空列表');
  if (items.length > MAX_LIST_ITEMS) {
    throw new SqlGuardError(`list 参数元素上限 ${MAX_LIST_ITEMS}，当前 ${items.length} 个`);
  }
  return items;
};

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

/**
 * 按 queryParams 声明的类型归一化请求值；**只归一类型，不做任何 SQL 拼接**。
 * @param {string} type string | number | date | list（未声明类型按 string）
 * @param {string|Array} raw express req.query 里的原始值（可以是数组）
 * @returns {string[]|number|string|null}
 */
const coerceValue = (type, raw) => {
  if (raw === undefined || raw === null) return null;
  const kind = String(type || 'string').toLowerCase();
  if (kind === 'list') return toList(raw);
  if (Array.isArray(raw)) throw new SqlGuardError(`${kind} 类型参数不接受数组，请用逗号分隔的单值`);
  const text = String(raw).trim();
  if (kind === 'number') {
    if (text === '' || !NUMBER_RE.test(text)) throw new SqlGuardError(`参数值不是合法数字: ${text.slice(0, 64)}`);
    return Number(text);
  }
  if (kind === 'date') {
    if (!DATE_RE.test(text)) {
      throw new SqlGuardError(`参数值不是合法日期（YYYY-MM-DD[ HH:mm[:ss]]）: ${text.slice(0, 64)}`);
    }
    return text;
  }
  if (kind === 'boolean') {
    if (['true', '1'].includes(text.toLowerCase())) return true;
    if (['false', '0'].includes(text.toLowerCase())) return false;
    throw new SqlGuardError(`参数值不是合法布尔（true/false/1/0）: ${text.slice(0, 64)}`);
  }
  return text;
};

module.exports = {
  BLOCKED_KEYWORDS,
  MAX_LIST_ITEMS,
  MAX_SQL_LENGTH,
  LIST_ITEM_SUFFIX,
  SqlGuardError,
  normalizeSql,
  maskLiteralsAndComments,
  assertReadOnly,
  extractPlaceholders,
  toMysqlPositional,
  expandListPlaceholders,
  listItemOf,
  coerceValue,
};
