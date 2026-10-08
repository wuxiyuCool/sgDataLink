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
