/**
 * 入站中文乱码兜底：GBK 系 Windows 控制台/管道可能让请求体以乱码字节到达，
 * Node 把非法 UTF-8 解码为 U+FFFD 替换符（且 Buffer 构造时会被净化剔除）。
 * 判据：UTF-8 字节序列里同时出现 EF/BF/BD 即疑似替换符 → 尝试 latin1→GBK 回译。
 * 依赖 iconv-lite 为传递依赖（body-parser→raw-body→iconv-lite），缺失时原样返回。
 */
let gbkDecoder = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  gbkDecoder = require('iconv-lite');
} catch (e) {
  gbkDecoder = null;
}

const fixMojibake = (raw) => {
  const text = String(raw || '');
  if (!gbkDecoder || !text) return text;
  const bytes = Buffer.from(text, 'utf8');
  const suspect = bytes.includes(0xef) && bytes.includes(0xbf) && bytes.includes(0xbd);
  if (!suspect) return text;
  try {
    const decoded = gbkDecoder.decode(Buffer.from(text, 'latin1'), 'GBK');
    return decoded.includes('\uFFFD') ? text : decoded;
  } catch (e) {
    return text;
  }
};

module.exports = { fixMojibake };
