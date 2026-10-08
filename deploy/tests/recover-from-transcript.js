/**
 * 从 Qoder 会话归档 (.jsonl) 中恢复历史 Write 工具写入的测试脚本文件。
 * 用法: node recover-from-transcript.js <目标文件名...>
 * 输出: 每个目标取最后一次 Write 的 content，写到本目录（deploy/tests）。
 */
const fs = require('fs');
const path = require('path');

const TRANSCRIPT_DIR = process.argv[2] || 'C:/Users/wxy/.qoder-cn/projects/D--code-code-go-dataLink';
const targets = process.argv.slice(3);
const outDir = __dirname;

const found = new Map();
const files = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith('.jsonl'));
for (const file of files) {
const lines = fs.readFileSync(path.join(TRANSCRIPT_DIR, file), 'utf8').split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const input = block.input || {};
    const fp = String(input.file_path || '');
    for (const t of targets) {
      if (fp.endsWith(t) && typeof input.content === 'string') {
        found.set(t, input.content); // 后出现的覆盖先出现的 => 取最后一次写入
      }
    }
  }
}
}
for (const t of targets) {
  const c = found.get(t);
  if (!c) { console.log(`MISS ${t}`); continue; }
  fs.writeFileSync(path.join(outDir, t), c);
  console.log(`OK   ${t} (${c.length} bytes)`);
}
