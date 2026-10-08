# 指标中心并发/性能测试报告（2026-10-08）

环境：本地 admin(3001, DB_DRIVER=mysql) → 内网 MySQL 5.7 10.45.34.222/dataLink（连接池 30）；engine 8080 直连；DeepSeek API 直连外网。压测脚本 `deploy/tests/bench-metric.js`（bench-ds.js 同族，Promise-pool 固定时长模式）。演示资产 `deploy/tests/seed-metric-demo.js`（dmtrade 域/4 指标/270 行近 45 天数据，常驻可重复刷）。

## 结果（conc=50，5s）

| 端点 | TPS | p50 | p95 | max | 错误 |
|------|-----|-----|-----|-----|------|
| GET /metric-dashboard | 270 | 176-187ms | 244-317ms | ~700ms | 0 |
| GET /metrics (size=20) | ~600 | 72-83ms | ~110ms | ~300ms | 0 |
| GET /metric-models | ~670 | 68-70ms | ~104ms | ~550ms | 0 |
| GET /metric-domains/tree | ~450 | 98-106ms | ~150ms | ~640ms | 0 |
| GET /metric-logs | ~620 | 72-77ms | ~110-130ms | ~740ms | 0 |
| GET /metric-terms | ~710 | 63-70ms | ~100ms | ~310ms | 0 |
| POST /metric-chat/ask (conc=3) | — | 1020ms | 1292-1577ms | — | 0（6 问 4 success/2 clarify） |

dashboard 拐点探测：conc=100 → TPS 270（p50 402ms）；conc=200 → TPS 303（p50 762ms）。**饱和不塌方、零错误**，天花板 ~300 TPS 由 5 表全量 list + 近 7d 问数日志扫描决定。

## 结论与已修项

- 读路径整体健康：内网 MySQL 单程 ~60ms 主导时延，池 30 下并发线性排队、无错误、无泄漏迹象。
- **已修：问数索引重建加 single-flight**（metricKnowledge.buildIndex 30s TTL 过期瞬间，并发 ask 曾各自触发全表重建）——现同进程只放一次。
- **已修：前端域管理误用 `description` 字段（契约是 `remark`/`owner`/`tablePrefix`）**——冒烟时发现保存 400，已改。
- 观察项（暂不动，量级不触发）：
  1. ask 链路同一指标编译执行 2 次（parsed.metrics + buildPlan 内部重编），高问数并发时可给 buildPlan 加 `precompiled` 透传；
  2. dashboard 全表扫描随 metrics/runs 行数增长，>1 万行后应改 SQL count 或 60s 缓存；
  3. 问数日志 trim 每 500 写一扫，写日志本身同步 await，可在高写入时挪后台。
- LLM 是 ask 唯一秒级瓶颈（DeepSeek ~1s），管理端其余操作不受 LLM 影响（编译/预览纯规则）。

---

## V9 复测（2026-10-09，含跨数据库语法识别与真库执行）

`bench-metric.js` 新增两个场景：**C 语法识别干跑**（`POST /metrics/validate`，11 类公式轮转，
每条按预期 valid 标志断言）与 **D 编译+真库执行**（`POST /metrics/:id/preview`，
MySQL 原子 / MySQL 复合 / Oracle 原子 三个指标，conc=20）。

### 场景 A：读端点（conc=50, 5s）

| 端点 | TPS | p50 | p95 | max | 错误 |
|------|-----|-----|-----|-----|------|
| GET /metric-dashboard | 204 | 219ms | 410ms | 911ms | 0 |
| GET /metrics (size=20) | 557 | 86ms | 128ms | 344ms | 0 |
| GET /metric-models | 623 | 74ms | 126ms | 343ms | 0 |
| GET /metric-domains/tree | 363 | 121ms | 187ms | 753ms | 0 |
| GET /metric-logs | 459 | 104ms | 164ms | 533ms | 0 |
| GET /metric-terms | 633 | 75ms | 109ms | 273ms | 0 |

### 场景 B：ask（conc=3, 6 问）

p50 1201ms / p95 1492ms，0 错误，4 success + 2 clarify。LLM 仍是唯一秒级瓶颈。

### 场景 C：跨数据库语法识别（conc=50, 5s）

| 指标 | 值 |
|------|-----|
| TPS | 257 |
| p50 / p95 / max | 188ms / 314ms / 584ms |
| 错误 | 0 |
| **正确性** | **11 类公式全部符合预期** |

覆盖与判定：`NVL` / `IFNULL` / `GREATEST` / `MOD` / `NULLIF` / `ROUND` / `CASE WHEN` / 基本四则
→ 接受；`SLEEP()`（非白名单）、`+ '元'`（字符串引号）、`SUM()`（复合禁聚合）、`... FROM x`（禁表名）
→ 拒绝。**结论：node-sql-parser 语法探针对方言函数宽容互认**（mysql 方言能解析 Oracle 的
NVL/TO_CHAR/TO_DATE/DECODE/TRUNC/REGEXP_LIKE/`||`，反之亦然），因此探针无需按方言分支；
真正的方言差异全部由编译器处理（见下）。为此把复合公式标量白名单从 7 个扩到 19 个
（补 NVL/IFNULL/DECODE/TRUNC/GREATEST/LEAST/MOD/SUBSTR/SUBSTRING/LENGTH/CONCAT/TO_NUMBER）。

### 场景 D：编译 + 真库执行（conc=20, 5s）

| 指标 | 方言/产物 | TPS | p50 | p95 | max | 错误 |
|------|-----------|-----|-----|-----|-----|------|
| dm_amt（原子） | MySQL `LIMIT` | 122 | 157ms | 212ms | 261ms | 0 |
| dm_unit（复合） | MySQL 合并扫描 | 63 | 255ms | 348ms | 1236ms | 0 |
| gk1（原子+过滤） | **Oracle `FETCH FIRST` + `TO_DATE`** | 34 | 564ms | 830ms | 1102ms | 0 |

**Oracle 方言端到端验证**：gk1 编译产物
`SELECT SUM(CASE WHEN t.EXTEND_COL7 = 1 THEN t.MATERIAL_WEIGHT END) AS gk1 FROM HR_PROD_MATERIAL t
WHERE t.PRODUCE_DT BETWEEN TO_DATE(...,'YYYY-MM-DD') AND TO_DATE(...) FETCH FIRST 1000 ROWS ONLY`
真实执行返回 238545，零错误。Oracle 比 MySQL 慢约 3.6×（p50 564 vs 157ms），
源于 Oracle 库网络往返与真实表扫描，非编译开销；复合 dm_unit 比原子慢因多一次展开编译+执行。

### V9 结论

- 三镜像上线前性能门禁通过：读端点 200-630 TPS 零错误，饱和点与 V8 一致（dashboard ~200-300 TPS）。
- 跨方言语法识别正确性 100%，MySQL/Oracle 混合部署可用；Oracle 吞吐约为 MySQL 的 1/3，
  高频 Oracle 指标建议走物化任务落表而非实时 preview。
- 观察项沿用上一轮（ask 双编译、dashboard 全表扫描、日志 trim），量级未变，暂不动。
