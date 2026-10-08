# 指标中心演示数据与页面走查清单

> 配套：`docs/METRIC-DEV.md`（开发规格）、`docs/API.md` 1.12（契约）。
> 常驻资产由 `deploy/tests/seed-metric-demo.js` 幂等生成（重复执行=刷数据+复用对象），浏览器验收/压测/问数演示共用同一套。

## 生成/刷新演示数据

```bash
cd node-express-boilerplate
set -a; source .env; set +a
ADMIN_USER=mtlint01 ADMIN_PASS=<密码> BASE=http://127.0.0.1:3001/api/v1 \
  node ../deploy/tests/seed-metric-demo.js
```

前置：admin(:3001)、engine(:8080) 已起（任务执行与预览走 engine 真库）；`DB_DRIVER=mysql`。

## 常驻资产一览

| 资产 | 标识 | 供哪个页面演示 |
| --- | --- | --- |
| 交易演示域 | code=`dmtrade`（根域），下挂二级 `dm_pay` 支付域 → 三级 `dm_pay_channel` 渠道域 | 指标域：悬停「+」/右键逐层建子域、删除联动 |
| 订单明细(DWD) 模型 | 物理表 `dm_order_src`（270 行，近 45 天，region/amt/status/pay_date） | 建模：字段角色、预览数据（真 SQL+真数据） |
| dm_amt 订单额 / dm_cnt 订单数 / dm_paid 实收额 | 原子（MEASURE，实收额带 `status='PAID'` 过滤） | 指标管理：原子定义、试跑 |
| dm_unit 件单价 | 复合 `${dm_amt} / ${dm_cnt}` | 指标管理：公式校验、展开树、血缘、问数树回填 |
| dm_paid_east 华东实收额 | 派生（基底 dm_paid + `region='华东'`） | 指标管理：派生继承、血缘依赖边 |
| 交易演示·地区总览 | mtk `dm_region_sum`，overwrite 全量 | 任务管理：写模式 overwrite、成功记录 |
| 交易演示·地区日汇总 | mtk `dm_region_daily`，upsert+BETWEEN 近14天+cron `0 30 2 * * ?`+fill 补空 | 任务管理：upsert/清洗规则/定时；含 成功→失败→成功 三条运行记录（失败为坏 filter SQL 演示，已修复重跑） |

## 逐页走查（每页顶部有「使用指南」折叠卡）

1. **首页概览**：域/模型/指标/任务统计应有真实数字；任务区显示近 24h 成功/失败（刚跑完 seed 即有）；问数区显示近 7 天提问量。
2. **指标域**：右键「交易演示」→ 新建子域（编码重复报 40901；删除有模型的域报 40902）；单击节点右侧联动模型。
3. **数据建模**：订单明细(DWD) →「预览数据」出真实行数据与执行 SQL；「字段」可改业务名/角色；「新建模型」可体验 ddl 界面建表（前缀=域编码）。
4. **指标管理**：dm_unit 详情看复合展开树+血缘；dm_paid_east 看派生依赖 dm_paid；试跑回真实值；改公式保存即新版本，可回滚。
5. **智能问数**：问「昨天的订单额」「昨天的件单价」（复合会展开子指标树并回填取值）「华东实收额是多少」；管理员在「历史」tab 可把日志转样例。
6. **任务管理**：两个演示任务的「记录」弹窗有 手动/定时 Tag、成功/失败色板、SQL 明细展开；「执行」即时物化到 `dm_region_sum`/`dm_region_daily`。
7. **系统配置**：LLM 四项 + embed 独立端点开关；来源徽标 table/env/default；apiKey 掩码不回显明文。

## 注意

- 回归脚本（`test-metric-*.js`）用 `${RUN}` 前缀临时资产自建自清，不会破坏以上 dm_* 资产；但 `test-metric-model.js` 会清 `llm.embed.*` 配置行，跑完需重配 embed 密钥。
- 演示账号见 `docs/METRIC-DEV.md`；严禁 memory/mock 模式做功能验证（用户长期约束）。
