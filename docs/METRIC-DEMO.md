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
| 订单明细(DWD) 模型 | 物理表 `dm_order_src`（270 行，近 45 天，region/amt/status/pay_date） | 建模：字段角色、预览数据（真 SQL+真数据）；表状态=引用表 |
| 渠道日报(草稿) 模型 | createType=ddl，表名 `dm_demo_draft`，状态 draft、表状态 未建表 | 建模生命周期①：草稿可改字段，但「生成表」禁用、拿它建指标会报「请先启用」 |
| 渠道日报(已建表) 模型 | createType=ddl，表名 `dm_demo_ads`（seed 时真执行 DDL 建出来），状态 online、表状态 已建表 | 建模生命周期②：启用→生成表→删除时出现「同时删除物理表」勾选（需手输表名） |
| 订单明细 维度取值档案 | 模型 `mdl-12064` 的 `region`(华东/华南/华北/西南) 与 `status`(PAID=已支付、CANCEL=已取消)，seed 时真探查并登记业务名；`id` 列被高基数保护跳过（正好演示另一种状态） | 建模页「字段 → 取值」；问数把「已支付」换回 `PAID` |
| 访问明细(DWD) 模型 | 物理表 `dm_visit_src`（80 行，**只有近 20 天**，site/uv/visit_date），与订单明细同数据源、不同时间列 | 任务管理：时间宽表的第二个源（跨模型对齐的前提） |
| dm_uv 访客数 | 原子（MEASURE，挂在访问明细上，timeColumn=`visit_date`） | 指标广场；宽表里那个「别的模型的指标」 |
| 交易演示·月度指标宽表(ADS) | createType=ddl，表名 `dm_wide_month`：`stat_period`(VARCHAR32·维度·主键) + `dm_amt`/`dm_cnt`/`dm_uv`(度量·**可空**) + `_etl_time`(时间) | 建模：目标表权威在这里；度量列可空才装得下 NULL 期次 |
| 交易演示·月度指标宽表 | mtk `dm_wide_month`，`align=time`+`timeGrain=month`+upsert+BETWEEN 近60天+cron `0 0 3 1 * ?`（每月 1 日 03:00） | 任务管理：时间宽表全套——按模型分组、时间全集 LEFT JOIN、幂等 upsert、空期次落 NULL |
| 建模分层树分类（4 个，契约 1.16） | DWD「交易域」＝订单明细+访问明细；ADS「应用出数」＝渠道日报(已建表)+月度宽表；DIM「维度登记」与 DWS「汇总层预留」是**空节点**；渠道日报(草稿) 故意留在 ADS 的**未分类**桶 | 建模页左树：5 个分层根固定不可增删、分类带描述（节点副标题+Tooltip）、节点计数、「未分类」有真实样本可点、空节点演示「先建分类后归类」 |
| dm_amt 订单额 / dm_cnt 订单数 / dm_paid 实收额 | 原子（MEASURE，实收额带 `status='PAID'` 过滤） | 指标广场：原子定义、试跑 |
| dm_unit 件单价 | 复合 `${dm_amt} / ${dm_cnt}` | 指标广场：公式校验、展开树、血缘、问数树回填 |
| dm_paid_east 华东实收额 | 派生（基底 dm_paid + `region='华东'`） | 指标广场：派生继承、血缘依赖边 |
| 交易演示·地区总览 | mtk `dm_region_sum`，overwrite 全量 | 任务管理：写模式 overwrite、成功记录 |
| 交易演示·地区日汇总 | mtk `dm_region_daily`，upsert+BETWEEN 近14天+cron `0 30 2 * * ?`+fill 补空 | 任务管理：upsert/清洗规则/定时；含 成功→失败→成功 三条运行记录（失败为坏 filter SQL 演示，已修复重跑） |

## 示例指标库（`ex_*` 15 条 · 配置抄作业用）

指标管理页按关键字 `ex_` 或域「交易演示」筛选即可看到。每条的**业务口径(caliber)字段就是一句配置说明**，
列表里可直接读；全部已用 preview 真跑验证（15/15 成功）。

| code | 类型 | 公式/定义要点 | 演示的配置能力 |
| --- | --- | --- | --- |
| `ex_sum_amt` | 原子 | `sum(amt)` + dataFormat=THOUSANDTH | 最基础度量聚合 + 千分位显示 |
| `ex_cnt_orders` | 原子 | `count(id)` | 计数型指标（agg 可选 sum/count/avg/max/min/count_distinct） |
| `ex_avg_ticket` | 原子 | `avg(amt)` + DECIMAL | 均值不必写复合除法；两位小数显示 |
| `ex_max_single` | 原子 | `max(amt)` | 极值型 |
| `ex_uv_region` | 原子 | FIELD 手写 `COUNT(DISTINCT t.region)` | 字段表达式型原子（必须含聚合函数，列名带 `t.`） |
| `ex_paid_amt` | 原子 | `sum(amt)` + filterSql `t.status='PAID'` | **业务过滤编译进聚合内 CASE WHEN**（不影响 WHERE 时间窗） |
| `ex_cancel_cnt` | 原子 | `count(id)` + filterSql CANCEL | 同表不同过滤=不同口径，作复合构件 |
| `ex_east_amt` | 派生 | baseMetricId=`ex_sum_amt` + filterSql `t.region='华东'` | **派生=defineType METRIC + baseMetricId(填 code)**，自动判 DERIVED |
| `ex_recent7_paid` | 派生 | base=`ex_paid_amt` + timePreset RECENT/7/DAY | 派生叠加**时间预设**（mode 也可 BETWEEN+start/end） |
| `ex_paid_share` | 复合 | `${ex_paid_amt} / ${ex_sum_amt}` + PERCENT | 四则比率 + 百分比显示 |
| `ex_unit_price` | 复合 | `ROUND(${ex_sum_amt} / NULLIF(${ex_cnt_orders},0), 2)` | 标量函数 + **NULLIF 防除零** |
| `ex_cancel_rate` | 复合 | `${ex_cancel_cnt} / NULLIF(${ex_cnt_orders},0)` | 复合禁聚合/禁表名（写 SUM 会被 400 拒） |
| `ex_big_flag` | 复合 | `CASE WHEN ${ex_sum_amt} > 10000 THEN 1 ELSE 0 END` | 公式内 CASE WHEN 分档打标 |
| `ex_nvl_safe` | 复合 | `NVL(${ex_sum_amt},0) / NULLIF(${ex_cnt_orders},0)` | **跨方言函数**：存原样，编译期归一为 COALESCE，MySQL/Oracle 都能跑 |
| `ex_greatest_amt` | 复合 | `GREATEST(${ex_sum_amt}, ${ex_paid_amt})` | 多指标取极值（MOD/LENGTH/SUBSTR/CONCAT 同理） |

**跨库语法识别要点**（详见 API.md 1.12「跨库方言三层处理」）：语法探针对 MySQL/Oracle 函数宽容互认，
所以 `NVL`/`IFNULL` 能保存——编译器已在生成 SQL 时归一为两库通用的 `COALESCE`；
`DECODE`/`TO_CHAR`/`DATE_FORMAT` 这类无法等价改写的，校验会回 **warning** 提示换库执行会报错（不阻断保存）。
Oracle 侧真实例子：`gk1 钢捆重量`（制造域 / HR_PROD_MATERIAL，filterSql `t.EXTEND_COL7 = 1`），
编译产物含 `TO_DATE(...)` + `FETCH FIRST 1000 ROWS ONLY`。

## 逐页走查（每页顶部有「使用指南」折叠卡）

1. **首页概览**：域/模型/指标/任务统计应有真实数字；任务区显示近 24h 成功/失败（刚跑完 seed 即有）；问数区显示近 7 天提问量。
2. **指标域**：右键「交易演示」→ 新建子域（编码重复报 40901；删除有模型的域报 40902）；单击节点右侧联动模型。
3. **数据建模**：订单明细(DWD) →「预览数据」出真实行数据与执行 SQL；「字段」可改业务名/角色，维度行点「取值」→「探查取值」（真查库，`id` 列会显示"高基数跳过"），`status` 行填业务名 PAID=已支付 保存即为码值字典。生命周期走一遍——「渠道日报(草稿)」：生成表按钮灰着（悬停说明「草稿需先启用」）、用它的度量列建指标会被拒；点「启用」→「生成表」弹窗展示方言 DDL、确认后库里真建表（表状态转「已建表」，再点一次幂等）；「渠道日报(已建表)」删除时才有「同时删除物理表」勾选且要手输表名，而引用表（订单明细）删除只有「不动物理表」的说明。新建模型走 ddl 时类型族+长度/小数位按所选数据源方言给（MySQL `VARCHAR(64)` / Oracle `VARCHAR2(64 CHAR)`）。**分层树（契约 1.16）**：页面左侧就是「全部模型 → 5 个分层根 → 分类」的树——分层根固定不可增删改名（层参与物理表命名），分类才是自己建的归组节点。点 DWD「交易域」右侧只剩那两个明细模型；点 ADS 下的「未分类」看到渠道日报(草稿)；DIM「维度登记」与 DWS「汇总层预留」是空节点（演示"分类先建、模型后归类"）。走一遍管理动作：树顶部「新建分类」→ 名称+描述（描述就是节点副标题）；节点上「编辑」改描述；**层级在编辑弹窗里是锁死的**（要换层只能新建再归类）；勾右侧多个模型 →「批量归类」选分类，故意把一个 DWD 模型往 ADS 分类里放会得到逐条点名的失败（其余照常成功，不整批回滚）；删一个挂着模型的分类 → 确认文案写明「N 个建模将退回未分类，不会删除建模本身」，删完那 N 条真的出现在「未分类」里，表和数据一根毛都没动。树与「指标域」是两条正交的轴：树上点分类后仍可用右侧的域/数据源/关键字继续缩小范围。
4. **指标广场**：默认按根域分节只列已上架指标（状态切「全部（含草稿）」才看得到草稿项），卡片右下角直达公式树/试跑/编辑/删除；dm_unit 详情看复合展开树+血缘，dm_paid_east 看派生依赖 dm_paid；改公式保存即新版本可回滚。「从表生成指标」走三步：选已启用模型（或就地登记一张表）→ 勾选度量列逐条改名/聚合/过滤 → 提交后逐条回显成败（故意用重复 code 试一次红色行，再点「重新提交失败项」）。**宽表入口**：在 dm_amt / dm_cnt / dm_uv 三张卡片上各点一次「＋宽表」（按钮变「已入宽表」），再点右上「勾的指标建宽表（3）」→ 自动跳到任务页并弹出已预填的时间宽表弹窗（dm_amt/dm_cnt 来自订单明细、dm_uv 来自访问明细，正是跨模型对齐的例子）。右上角「表格」切回原分页视图。
5. **智能问数**：问「昨天的订单额」「昨天的件单价」（复合会展开子指标树并回填取值）「华东实收额是多少」；登记过码值后再问「昨天的已支付订单额」——答案卡下方会列出「已按取值档案把『已支付』→`PAID`」这类替换（以及哪些值不在档案里）。管理员在「历史」tab 可把日志转样例。
6. **任务管理**：两个演示任务的「记录」弹窗有 手动/定时 Tag、成功/失败色板、SQL 明细展开；「执行」即时物化到 `dm_region_sum`/`dm_region_daily`。列表「对齐」列可区分「同模型」与「时间宽表·month」。
7. **时间宽表走查（契约 1.15，用演示任务 mtk 月度指标宽表）**：
   - 打开该任务编辑：对齐模式=时间宽表、目标粒度=月、分组维度禁用（切回「同模型聚合」才会出现），目标表是「选建模表」态且已锁定 `dm_wide_month`；「目标表结构」上方按模型列出两个分组（订单明细.pay_date → dm_amt、dm_cnt；访问明细.visit_date → dm_uv），列出的度量列类型来自方言层。
   - 点「保存前 Preview 语句」：应看到 `INSERT … ON DUPLICATE KEY UPDATE`，内含两个子查询各 `GROUP BY DATE_FORMAT(t.xxx_date, '%Y-%m')`、`SELECT \`stat_period\` FROM (…) UNION SELECT …` 的时间全集基表和两路 `LEFT JOIN`。
   - 故意把目标粒度改成「天」→ 保存被后端拒绝（演示任务里没有声明粗粒度的指标，所以这条要用 `dm_*_mamt` 之类自建指标验证；回归套件 `test-metric-wide` 已覆盖，界面报错文案会点名是哪个指标卡住了粒度）。
   - 把 `dm_wide_month` 的 `dm_uv` 列在建模页删掉再保存任务 → 红字「目标建模表缺列：dm_uv（建议 DECIMAL(24,6)）」+「去建模页补列」直达；点过去自动打开该模型字段弹窗，补回列再回任务页保存即通过。
   - 看数据：`SELECT * FROM dm_wide_month` —— 2026-08 只有订单（`dm_uv` 为 **NULL**），2026-09 与 2026-10 三个指标都有值；这就是「当期没数落 NULL 而不是 0」的活样本，也是 `stat_period` 作 upsert 主键可反复重跑不重复的原因。
8. **系统配置**：共 10 项——LLM 四项 + embed 独立端点三项 + 「候选值进问数 Prompt」开关与条数；来源徽标 table/env/default；apiKey 掩码不回显明文。**取值开关默认关**：候选值是真实业务数据，开了才会随 prompt 出站（关掉时已登记码值仍在服务端做值校正，不外发）。

## 注意

- 回归脚本（`test-metric-*.js`）用 `${RUN}` 前缀临时资产自建自清，不会破坏以上 dm_* 资产；`test-metric-model.js` 会临时改写 `llm.model`/`llm.embed.*`，但**跑前快照、跑完还原**（共享元库里这些就是生产配置，别退回成删除写法——见 METRIC-DEV §12 红线 11）。
- 演示账号见 `docs/METRIC-DEV.md`；严禁 memory/mock 模式做功能验证（用户长期约束）。
