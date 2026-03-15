# IFRS17 财务影响测试平台计算引擎手册

## 1. 文档目的
本手册用于完整说明当前 Demo 版本计算引擎的实现口径，覆盖：
- 输入数据如何进入引擎
- Node 0 到 Node 7 各自负责什么
- 每一步为什么这样算
- 每一步使用什么公式、什么时间窗口、什么时点假设
- 最终利润表（PL）和资产负债表（BS）每个项目如何生成
- 哪些内容已经实现，哪些内容在当前 Demo 中被简化

本文档的定位是“内部知识库/操作手册”。
目标读者包括：
- 产品和开发人员
- 精算/财务口径确认人员
- 后续需要调用本引擎做问答、解释或自动调参的大模型

## 2. 当前版本覆盖范围
### 2.1 Node 0 到 Node 7 是否覆盖了参与计算的所有因素
结论：**覆盖了所有核心计算因素**，但最终报表生成仍然包含 3 个“后处理层”，它们不是新的业务因素，而是把节点输出装配成报表。

Node 0 到 Node 7 覆盖的核心因素如下：
- 全局参数：`df`、CSM 计息率、CSM 释放率、投资收益率
- 基础现金流：预期保费、实际保费、预期赔付、实际赔付、佣金、费用
- 双口径 BEL：`BEL(current)` 与 `BEL(locked)`
- 风险调整 RA（当前 Demo 默认值为 0，但完整保留链路）
- 首日履约现金流与初始 CSM
- IFIE PL 利息与 OCI
- 经验偏差与 CSM unlocking
- CSM roll-forward

### 2.2 额外的 3 个后处理层
以下 3 层不属于 Node 0-7，但属于最终输出不可缺少的装配层：
1. 投资资产台账（Asset Ledger）
2. 利润表组装（PL Assembly）
3. 资产负债表组装（BS Assembly）

因此，若要完整描述“从 input 到最终报表”，必须写成：
`Input -> Node0~7 -> Asset Ledger -> PL/BS -> 报表展示层`

## 3. 全局口径与约定
### 3.1 符号约定
当前版本采用：**输入值自带最终符号**。
- 正数：表示收入流入或资产增加
- 负数：表示支出流出或资产减少

在当前再保 Demo 里，常见输入口径为：
- `commission`：通常为正，表示期初收到的再保佣金
- `premium`：通常为负，表示分出保费支出
- `claim`：通常为正，表示摊回赔款收入
- `expense`：当前保留字段，但多数测试场景为 0

### 3.2 时点约定
- `commission`：视作**期初现金流**（BOP flow）
- `premium / claim / expense`：视作**期末现金流**（EOP flow）

这会直接影响：
- Node 2 的贴现方式
- 投资资产台账的计息基础

### 3.3 折现因子约定
当前版本只有一条 `df` 曲线。
- `BEL(current)`：每个月都重新从曲线起点调用同一条 `df`
- `BEL(locked)`：从当期所在位置继续沿同一条 `df` 曲线向后调用

所以，“current vs locked”的区别不是输入两条曲线，而是**同一条曲线的两种调用方法**。

### 3.4 M0 / M1 / Y1 的展示口径
- `M0`：原始输入的第 1 行，只用于初始确认和建账，不作为 PL/BS 的 `M1`
- `M1`：原始输入的第 2 行，即首个经营月
- `Y1`：从 `M1` 开始累计 12 个月
- `BS` 年表：取每年末余额
- `PL` 年表：取每年内逐月发生额求和

也就是说，最终报表中的 `M1` 不是原始输入第 1 行，而是第 2 行。

## 4. 输入数据字典
### 4.1 必填字段
| 字段 | 含义 | 时点属性 | 说明 |
|---|---|---|---|
| `date` | 月份 | 时间索引 | 必须可排序 |
| `expected_premiums` | 预期保费 | 期末 | 输入值自带符号 |
| `actual_premiums` | 实际保费 | 期末 | 输入值自带符号 |
| `expected_claims` | 预期赔付 | 期末 | 输入值自带符号 |
| `actual_claims` | 实际赔付 | 期末 | 输入值自带符号 |
| `commission` | 佣金 | 期初 | 输入值自带符号 |
| `df` | 折现因子 | 曲线点 | 如有缺失则线性插值 |

### 4.2 选填字段
| 字段 | 含义 | 默认值 |
|---|---|---|
| `expected_expenses` | 预期费用 | 0 |
| `actual_expenses` | 实际费用 | 0 |

### 4.3 输入预处理逻辑
输入进入引擎前，会做以下预处理：
1. 标头归一化与别名映射
2. 缺失必填字段检查
3. 按 `date` 升序排序
4. 缺失 `df` 做线性插值
5. 增加 `month_index = 1, 2, 3 ...`

## 5. 总体链路总览
### 5.1 主链路
1. `prepare()`：输入归一化
2. `calcNode1()`：净现金流与偏差
3. `calcNode2()`：双 BEL
4. `calcNode3()`：RA
5. `calcNode4()`：首日 FCF 与初始 CSM
6. `calcNode5()`：IFIE PL 利息与 OCI
7. `calcNode6()`：经验偏差与 CSM unlocking
8. `calcNode7()`：CSM roll-forward
9. `buildAssetLedger()`：投资资产台账
10. `buildPL()`：PL 组装
11. `buildBS()`：BS 组装
12. `buildFlowReport()` / `buildStockReport()`：生成 M1 + Y1~Y5 展示层

### 5.2 最小必要依赖关系
- Node 2 依赖 Node 1 的预期净现金流
- Node 4 依赖 Node 3 的 `RA_opening`
- Node 5 依赖 Node 2 的 `BEL_locked / delta_bel`
- Node 6 依赖 Node 1 的偏差拆分
- Node 7 依赖 Node 4 的 `initial_csm`、Node 6 的 `unlocking_to_csm`
- PL/BS 依赖 Node 7 与投资台账

## 6. Node 0 到 Node 7 详细说明

---

## Node 0：全局参数定义
### 6.0.1 目标
定义整条链路共用的系统参数：
- `df`
- `CSM计息率`
- `CSM释放率`
- `投资收益率`

### 6.0.2 业务原理
Node 0 不直接计算金额，而是定义全局环境。后续节点所有的贴现、CSM 计息、CSM 释放、投资收益，都要读取这里的参数。

### 6.0.3 当前实现
当前版本并不单独存储 Node 0 表，而是通过：
- 输入表中的 `df`
- 全局变量 `GLOBAL_DEFAULTS / globalVars`
来驱动全链路。

### 6.0.4 时间窗口
- `df`：逐月曲线点
- CSM 计息率：年化，进入 Node 7 时换算成月率 `年率 / 12`
- CSM 释放率：年化，进入 Node 7 时换算成月率 `年率 / 12`
- 投资收益率：年化，进入投资台账时换算成月率 `年率 / 12`

### 6.0.5 M1 / M2 / M3 示例
| 期间 | df | CSM计息率 | CSM释放率 | 投资收益率 |
|---|---:|---:|---:|---:|
| M1 | 1.00000 | 4.00% | 5.00% | 3.50% |
| M2 | 0.95000 | 4.00% | 5.00% | 3.50% |
| M3 | 0.99640 | 4.00% | 5.00% | 3.50% |

---

## Node 1：现金流台账与偏差
### 6.1.1 目标
生成：
- 预期净现金流 `exp_net_cf`
- 实际净现金流 `act_net_cf`
- 保费、赔付、费用的偏差拆分

### 6.1.2 业务原理
Node 1 是整个模型的现金流起点。它不做贴现，不做利润确认，只做“把每个月发生了什么整理清楚”。

### 6.1.3 公式
预期净现金流：

```text
exp_net_cf_t = expected_claims_t
             + expected_expenses_t
             + commission_t
             + expected_premiums_t
```

文字版：
- 第 `t` 个月的预期净现金流，等于当月预期赔付、预期费用、佣金和预期保费直接相加。
- 这里不再额外做人为翻符号，输入表中的正负号就是最终口径。

数字版示例（以 M1 为例）：

```text
exp_net_cf_M1 = 50 + 0 + 0 + (-100) = -50
```

实际净现金流：

```text
act_net_cf_t = actual_claims_t
             + actual_expenses_t
             + commission_t
             + actual_premiums_t
```

文字版：
- 第 `t` 个月的实际净现金流，等于当月实际赔付、实际费用、佣金和实际保费直接相加。

数字版示例（以 M1 为例）：

```text
act_net_cf_M1 = 60 + 0 + 0 + (-110) = -50
```

偏差拆分：

```text
var_premium_t = actual_premiums_t - expected_premiums_t
var_claim_t   = actual_claims_t   - expected_claims_t
var_expense_t = actual_expenses_t - expected_expenses_t
var_net_cf_t  = act_net_cf_t - exp_net_cf_t
```

文字版：
- 保费偏差 = 实际保费 - 预期保费
- 赔付偏差 = 实际赔付 - 预期赔付
- 费用偏差 = 实际费用 - 预期费用
- 净现金流偏差 = 实际净现金流 - 预期净现金流

数字版示例（以 M1 为例）：

```text
var_premium_M1 = -110 - (-100) = -10
var_claim_M1   = 60 - 50 = 10
var_expense_M1 = 0 - 0 = 0
var_net_cf_M1  = -50 - (-50) = 0
```

### 6.1.4 时间窗口
- 逐月计算
- 不做跨期累计
- `commission` 按期初出现，但在 Node 1 仍只是现金流组成部分

### 6.1.5 M1 / M2 / M3 示例
示例输入：
| 期间 | expected_premiums | actual_premiums | expected_claims | actual_claims | commission |
|---|---:|---:|---:|---:|---:|
| M1 | -100 | -110 | 50 | 60 | 0 |
| M2 | -90 | -95 | 45 | 40 | 0 |
| M3 | -80 | -78 | 40 | 41 | 0 |

示例输出：
| 期间 | exp_net_cf | act_net_cf | var_premium | var_claim | var_net_cf |
|---|---:|---:|---:|---:|---:|
| M1 | -50 | -50 | -10 | 10 | 0 |
| M2 | -45 | -55 | -5 | -5 | -10 |
| M3 | -40 | -37 | 2 | 1 | 3 |

---

## Node 2：双 BEL 调用
### 6.2.1 目标
生成：
- `BEL(current)`
- `BEL(locked)`
- `delta_bel = bel_current - bel_locked`

### 6.2.2 业务原理
这是当前引擎最核心的白盒逻辑之一。
关键不在于两条曲线，而在于**对同一条 df 的两种调用方式**：
- `current`：每个月都重新从曲线起点看未来
- `locked`：每个月沿着绝对月份继续往后看

### 6.2.3 先定义期末/期初现金流
期末现金流：

```text
EOP_Flow_t = expected_claims_t + expected_expenses_t + expected_premiums_t
```

文字版：
- 期末现金流只包含期末属性的项目，即赔付、费用、保费。
- `commission` 不在这里，它单独作为期初现金流处理。

数字版示例（以 M1 为例）：

```text
EOP_Flow_M1 = 50 + 0 + (-100) = -50
```

期初现金流：

```text
BOP_Flow_t = commission_t
```

文字版：
- 期初现金流只有佣金。

数字版示例（以 M0 为例）：

```text
BOP_Flow_M0 = 200
```

### 6.2.4 公式：BEL(current)
设当前月为 `t`，未来月为 `j`，则：

```text
BEL_current_t
= Sum_{j=t..N} [EOP_Flow_j × df_{j-t}] + [commission_j × df_{j-t-1}]
```

其中：
- `df_{-1} = 1`
- 这表示每个月都从同一条曲线的第一个点重新开始贴现

文字版：
- 第 `t` 个月的 `BEL(current)`，等于从第 `t` 个月到最后一个月的所有未来期末现金流，使用“从当前月重新开始”的 `df` 曲线做贴现后求和，再加上未来佣金按期初口径贴现后的求和。
- 这里的关键是“重新开始”。也就是说，不管现在站在 M1、M2 还是 M3，`current` 都把本月看作新起点。

数字版示例（以 M1 为例）：
- 假设从 M1 往后只有一笔非零期末现金流 `EOP_Flow_M1 = -50`
- 没有未来佣金
- 则：

```text
BEL_current_M1 = -50 × 1 + 0 = -50
```

### 6.2.5 公式：BEL(locked)
```text
BEL_locked_t
= Sum_{j=t..N} [EOP_Flow_j × (df_j / df_t)]
+ [commission_j × (df_{j-1} / df_{t-1})]
```

其中：
- `df_{t-1}` 为上一个月的折现因子
- 若 `t = 0`，则 `df_{-1}` 视为 1
- 这表示锁定 BEL 从当期所在位置继续滚动，而不是从曲线起点重置

文字版：
- 第 `t` 个月的 `BEL(locked)`，等于从第 `t` 个月到最后一个月的所有未来期末现金流，按“锁定视角”从当期所在位置继续向后滚动贴现。
- 对期末现金流来说，使用的是 `df_j / df_t`。
- 对佣金这类期初现金流来说，使用的是 `df_{j-1} / df_{t-1}`。
- 它和 `BEL(current)` 的差别不在输入曲线不同，而在“调用同一条 df 的方式不同”。

数字版示例（以 M1 为例）：
- 假设从 M1 往后只有一笔非零期末现金流 `EOP_Flow_M1 = -50`
- `df_M1 = 0.95`
- 没有未来佣金
- 则：

```text
BEL_locked_M1 = -50 × (0.95 / 0.95) + 0 = -50
```

### 6.2.6 财务差异
```text
delta_bel_t = bel_current_t - bel_locked_t
```

文字版：
- 财务差异等于同一个月份下 `current BEL` 和 `locked BEL` 的差额。
- 它表示：仅因为折现调用视角不同而产生的 BEL 差异。

数字版示例（以 M1 为例）：

```text
delta_bel_M1 = -50 - (-50) = 0
```

### 6.2.7 时间窗口
- 每个月都向后看完整剩余现金流窗口
- `commission` 以期初方式进入现值
- `claim/premium/expense` 以期末方式进入现值

### 6.2.8 M1 / M2 / M3 示例
示例数据：
- M0: `commission = 200`, `df = 1`
- M1: `EOP_Flow = -50`, `df = 0.95`
- M2: `EOP_Flow = 0`, `df = 0.9964`
- M3: `EOP_Flow = 0`, `df = 0.9946`

示例输出：
| 期间 | BEL(current) | BEL(locked) | delta_bel |
|---|---:|---:|---:|
| M0 | 152.50 | 152.50 | 0.00 |
| M1 | -50.00 | -50.00 | 0.00 |
| M2 | 0.00 | 0.00 | 0.00 |
| M3 | 0.00 | 0.00 | 0.00 |

备注：如果未来仍有非零现金流，则 `BEL(current)` 与 `BEL(locked)` 通常不会相等。

---

## Node 3：风险调整（RA）
### 6.3.1 目标
生成：
- `ra_opening`
- `ra_interest`
- `ra_release`
- `ra_closing`

### 6.3.2 业务原理
当前 Demo 允许保留 RA 节点结构，但默认 `raRatio = 0`。这样做的目的是：
- 不让 RA 阻碍核心演示
- 但保留将来接真实 RA 逻辑的接口

### 6.3.3 公式
```text
ra_opening_t = |bel_current_t| × raRatio
ra_closing_t = |bel_current_{t+1}| × raRatio
```

文字版：
- 当期期初 RA 取当期 `BEL(current)` 绝对值乘以 `RA比例`。
- 当期期末 RA 取下一期 `BEL(current)` 绝对值乘以 `RA比例`。

数字版示例（以 M1 为例）：

```text
ra_opening_M1 = |-100| × 2% = 2.00
ra_closing_M1 = |-90| × 2% = 1.80
```

```text
ra_interest_t = ra_opening_t × (df_{t-1} / df_t - 1)
```

文字版：
- RA 计息，等于当期期初 RA 乘以上期到当期的贴现因子回拨比例。

数字版示例（以 M1 为例）：

```text
ra_interest_M1 = 2.00 × (1 / 1 - 1) = 0
```

```text
ra_release_t = ra_opening_t - ra_closing_t + ra_interest_t
```

文字版：
- RA释放 = 期初 RA - 期末 RA + RA计息。

数字版示例（以 M1 为例）：

```text
ra_release_M1 = 2.00 - 1.80 + 0 = 0.20
```

### 6.3.4 时间窗口
- 逐月滚动
- `ra_closing` 依赖下一期 `bel_current`

### 6.3.5 M1 / M2 / M3 示例（以 `raRatio = 2%` 为例）
假设：
| 期间 | bel_current |
|---|---:|
| M1 | -100 |
| M2 | -90 |
| M3 | -80 |

示例输出：
| 期间 | ra_opening | ra_closing | ra_interest | ra_release |
|---|---:|---:|---:|---:|
| M1 | 2.00 | 1.80 | 0.00 | 0.20 |
| M2 | 1.80 | 1.60 | 0.02 | 0.22 |
| M3 | 1.60 | 0.00 | 0.01 | 1.61 |

备注：当前正式 Demo 中，`raRatio = 0`，因此这些值通常全为 0。

---

## Node 4：初始确认与首日损益
### 6.4.1 目标
生成：
- `fcf_day1`
- `initial_csm`
- `day1_loss_component`

### 6.4.2 业务原理
Node 4 只在初始确认时点（M0）起作用。
当前 Demo 假设：
- 不单独展开首日亏损组件
- 当前实现直接按 `CSM0 = -BEL0` 的思路建立初始 CSM

### 6.4.3 公式
```text
fcf_day1 = bel_current_0 + ra_opening_0
```

文字版：
- 首日履约现金流，等于初始时点的 `BEL(current)` 加上首日 `RA`。

数字版示例：

```text
fcf_day1 = 152.50 + 0 = 152.50
```

```text
initial_csm_0 = -fcf_day1
```

文字版：
- 初始 CSM 直接取首日履约现金流的相反数。

数字版示例：

```text
initial_csm_0 = -152.50
```

```text
day1_loss_component = 0   （当前 Demo 固定值）
```

文字版：
- 当前 Demo 不单独展开首日亏损组件，因此无论输入如何，这一项都先固定为 0。

### 6.4.4 时间窗口
- 仅 M0 有意义
- M1 以后不再重新执行首日确认

### 6.4.5 M0 / M1 / M2 示例
假设：
- `bel_current_0 = 152.50`
- `ra_opening_0 = 0`

则：
| 期间 | fcf_day1 | initial_csm | day1_loss_component |
|---|---:|---:|---:|
| M0 | 152.50 | -152.50 | 0 |
| M1 | 0 | 0 | 0 |
| M2 | 0 | 0 | 0 |

实现备注：当前代码没有对 `initial_csm` 做 `max(0, ...)` 限制，而是直接取 `-fcf_day1`。这是当前 Demo 口径的一部分。

---

## Node 5：保险财务收支（IFIE）
### 6.5.1 目标
生成：
- `ifie_pnl_locked_interest`
- `ifie_oci_discount_effect`

### 6.5.2 业务原理
Node 5 负责把资金时间价值拆成两部分：
- 进入 P&L 的锁定 BEL 计息
- 进入 OCI 的 BEL 财务差异期间变动

### 6.5.3 锁定 BEL 计息公式
当前实现采用：

```text
rate_t = 1 - df_t / df_{t-1}
```

文字版：
- 当期锁定 BEL 计息率，等于 `1 - 当期df / 上期df`。
- 这是把贴现因子随时间推进的变化转换成一个当期利息比例。

数字版示例（以 M1 为例）：

```text
rate_M1 = 1 - 0.95 / 1 = 0.05
```

```text
BEL_locked_interest_t = bel_locked_t × rate_t
```

其中：
- 第 1 行（M0）不计息，`rate_0 = 0`
- 这里使用的是**当期 bel_locked**，因为 bel 本身是期末余额

文字版：
- 当期锁定 BEL 计息 = 当期期末 `BEL(locked)` × 当期计息率。

数字版示例（以 M1 为例）：

```text
BEL_locked_interest_M1 = -50 × 0.05 = -2.50
```

### 6.5.4 OCI 公式
```text
OCI_t = if t = 0 then delta_bel_t
        else delta_bel_t - delta_bel_{t-1}
```

文字版：
- M0 的 OCI 直接等于 M0 的 `delta_bel`。
- 从 M1 开始，OCI 看的是“财务差异本月比上月多了多少”。

数字版示例（以 M1 为例）：

```text
OCI_M1 = 0 - 0 = 0
```

### 6.5.5 时间窗口
- 锁定 BEL 计息依赖当期和上期 `df`
- OCI 依赖当期与上期的 `delta_bel`

### 6.5.6 M1 / M2 / M3 示例
假设：
| 期间 | bel_locked | df |
|---|---:|---:|
| M0 | 152.50 | 1.0000 |
| M1 | -50.00 | 0.9500 |
| M2 | 0.00 | 0.9964 |
| M3 | 0.00 | 0.9946 |

则：
| 期间 | 计息率 `1 - df_t/df_{t-1}` | BEL锁定计息 |
|---|---:|---:|
| M0 | 0.0000 | 0.00 |
| M1 | 0.0500 | -2.50 |
| M2 | -0.0488 | 0.00 |
| M3 | 0.0018 | 0.00 |

若 `delta_bel` 各期都为 0，则 OCI 也为 0。

---

## Node 6：经验偏差与 CSM 解锁
### 6.6.1 目标
生成：
- `experience_to_pnl`
- `unlocking_to_csm`

### 6.6.2 业务原理
Node 6 负责把偏差拆成两类：
- 一类留作经验分析（理论上可进入当期经营结果）
- 一类进入 CSM unlocking

当前 Demo 采用简化代理：
- `claim variance` 和 `expense variance` 形成经验偏差分析值
- `premium variance` 直接作为 `unlocking_to_csm`

### 6.6.3 公式
```text
experience_to_pnl_t = var_claim_t × claimVarianceWeight + var_expense_t
```

文字版：
- 经验偏差分析值，等于赔付偏差乘以赔付偏差权重，再加上费用偏差。

数字版示例（以 M1 为例）：

```text
experience_to_pnl_M1 = 10 × 1 + 0 = 10
```

```text
unlocking_to_csm_t = var_premium_t × premiumVarianceWeight
```

文字版：
- 进入 CSM 的 unlocking，当前 Demo 简化为“保费偏差 × 保费权重”。

数字版示例（以 M1 为例）：

```text
unlocking_to_csm_M1 = -10 × 1 = -10
```

### 6.6.4 时间窗口
- 逐月计算
- 不累计，直接传给 Node 7

### 6.6.5 M1 / M2 / M3 示例
沿用 Node 1 的偏差：
| 期间 | var_claim | var_expense | var_premium |
|---|---:|---:|---:|
| M1 | 10 | 0 | -10 |
| M2 | -5 | 0 | -5 |
| M3 | 1 | 0 | 2 |

若 `claimVarianceWeight = 1`，`premiumVarianceWeight = 1`，则：
| 期间 | experience_to_pnl | unlocking_to_csm |
|---|---:|---:|
| M1 | 10 | -10 |
| M2 | -5 | -5 |
| M3 | 1 | 2 |

实现备注：当前最终 PL 并没有单独拉出 `experience_to_pnl` 这一行；在当前 Demo 里，它更多是偏差诊断值，而 `unlocking_to_csm` 则会真正进入 Node 7。

---

## Node 7：CSM 摊销与利润呈现
### 6.7.1 目标
生成：
- `csm_opening`
- `csm_interest`
- `csm_pre_amort`
- `csm_amortization`
- `csm_closing`

### 6.7.2 业务原理
Node 7 是利润释放的核心节点。它把：
- 初始 CSM
- CSM 计息
- unlocking
- CSM 释放
串成完整的 CSM roll-forward。

### 6.7.3 公式
设：
- `i_csm = csmAccretionRateAnnual / 12`
- `alpha_csm = csmAmortizationRateAnnual / 12 × csmReleaseScale`

则：

```text
csm_opening_t = if t = 0 then initial_csm_0 else csm_closing_{t-1}
```

文字版：
- M0 的期初 CSM 就是初始 CSM。
- 从 M1 开始，每个月的期初 CSM 等于上个月的期末 CSM。

数字版示例（以 M1 为例）：

```text
csm_opening_M1 = csm_closing_M0 = -152.50
```

```text
csm_interest_t = if t = 0 then 0 else csm_opening_t × i_csm
```

文字版：
- M0 不计息。
- 从 M1 开始，CSM 计息 = 期初 CSM × 月度 CSM 计息率。

数字版示例（以 M1 为例）：

```text
csm_interest_M1 = -152.50 × (4% / 12) ≈ -0.51
```

```text
csm_pre_amort_t = csm_opening_t + csm_interest_t + unlocking_to_csm_t
```

文字版：
- 摊销前 CSM = 期初 CSM + CSM计息 + unlocking。

数字版示例（以 M1 为例，假设 unlocking 为 0）：

```text
csm_pre_amort_M1 = -152.50 + (-0.51) + 0 = -153.01
```

```text
csm_amortization_t = if t = 0 then 0 else csm_pre_amort_t × alpha_csm
```

文字版：
- M0 不释放。
- 从 M1 开始，CSM释放 = 摊销前 CSM × 月度释放率。

数字版示例（以 M1 为例）：

```text
csm_amortization_M1 = -153.01 × (5% / 12) ≈ -0.64
```

```text
csm_closing_t = csm_pre_amort_t - csm_amortization_t
```

文字版：
- 期末 CSM = 摊销前 CSM - CSM释放。

数字版示例（以 M1 为例）：

```text
csm_closing_M1 = -153.01 - (-0.64) ≈ -152.37
```

说明：
- 上面这个“数字版”是纯公式代入示例。
- 节点示例表中的数值使用了更精细的内部小数，因此与两位小数手算结果可能有轻微差异。

### 6.7.4 时间窗口
- M0 建立 CSM opening / closing 起点
- M1 起进入正常计息和释放

### 6.7.5 M0 / M1 / M2 / M3 示例
假设：
- `initial_csm_0 = -152.50`
- `i_csm = 4% / 12 = 0.3333%`
- `alpha_csm = 5% / 12 = 0.4167%`
- `unlocking_to_csm = 0`

则：
| 期间 | csm_opening | csm_interest | csm_amortization | csm_closing |
|---|---:|---:|---:|---:|
| M0 | -152.50 | 0.00 | 0.00 | -152.50 |
| M1 | -152.50 | -0.51 | -0.64 | -151.87 |
| M2 | -151.87 | -0.51 | -0.63 | -151.24 |
| M3 | -151.24 | -0.50 | -0.63 | -150.61 |

说明：
- 因为当前 CSM 余额是负数，所以 `CSM计息` 和 `CSM释放` 在底层计算值上也为负数。
- 在最终 PL 中，`CSM释放` 会乘以负号后作为收入展示。

---

## 7. 后处理层 A：投资资产台账
### 7.1 目标
生成：
- `investment_base`
- `investment_return`
- `investment_assets`

### 7.2 业务原理
当前 Demo 把投资收益放在资产端单独记录，不参与 BEL/CSM 的负债端计量。

### 7.3 公式
设 `r_inv = investmentReturnRate / 12`。

```text
investment_assets_opening_t = if t = 0 then 0 else investment_assets_{t-1}
```

文字版：
- 投资资产期初余额，等于上个月的投资资产期末余额。
- 只有 M0 的期初余额固定为 0。

```text
investment_base_t = if t = 0 then max(opening_t, 0)
                    else max(opening_t + commission_t, 0)
```

文字版：
- 投资计息基础 = 期初投资资产 + 当期佣金。
- 但 M0 只建账不计息，因此 M0 的计息基础虽然可展示，实际投资收益仍固定为 0。

数字版示例（以 M1 为例）：

```text
investment_base_M1 = max(200 + 0, 0) = 200
```

```text
investment_return_t = if t = 0 then 0 else investment_base_t × r_inv
```

文字版：
- M0 不计投资收益。
- 从 M1 开始，投资收益 = 投资计息基础 × 月度投资收益率。

数字版示例（以 M1 为例）：

```text
investment_return_M1 = 200 × (3.5% / 12) = 0.58
```

```text
investment_assets_t = opening_t
                    + commission_t
                    + actual_claims_t
                    + actual_premiums_t
                    + actual_expenses_t
                    + investment_return_t
```

文字版：
- 投资资产期末余额 = 期初投资资产 + 当期佣金 + 当期实际赔付 + 当期实际保费 + 当期实际费用 + 当期投资收益。

数字版示例（以 M1 为例）：

```text
investment_assets_M1 = 200 + 0 + 50 + (-100) + 0 + 0.58 = 150.58
```

### 7.4 时间窗口
- `commission` 当期参与投资计息
- `claim / premium / expense` 当期不参与计息，只进入期末资产
- M0 只建账，不计投资收益

### 7.5 M0 / M1 / M2 / M3 示例
假设：
- `commission(M0)=200`
- `actual_claims(M1)=50`
- `actual_premiums(M1)=-100`
- `r_inv = 3.5% / 12 = 0.2917%`

则：
| 期间 | investment_base | investment_return | investment_assets |
|---|---:|---:|---:|
| M0 | 0.00 | 0.00 | 200.00 |
| M1 | 200.00 | 0.58 | 150.58 |
| M2 | 150.58 | 0.44 | 151.02 |
| M3 | 151.02 | 0.44 | 151.46 |

## 8. 后处理层 B：利润表（PL）组装
### 8.1 当前版本 PL 字段
当前代码输出以下项目：
- `actual_claim_income`
- `expected_claim_expense`
- `csm_release_income`
- `csm_interest_expense`
- `bel_locked_interest_expense`
- `investment_return_income`
- `oci`
- `net_income`
- `total_comprehensive_income`

### 8.2 PL 每个项目的来源
| PL项目 | 来源 | 公式 |
|---|---|---|
| 实际赔付收入 | 原始输入 / Node1 | `actual_claim_income = actual_claims` |
| 预期赔付支出 | 原始输入 / Node1 | `expected_claim_expense = -expected_claims` |
| CSM释放收入 | Node7 | `csm_release_income = -csm_amortization` |
| CSM计息支出 | Node7 | `csm_interest_expense = csm_interest` |
| BEL(锁定)计息支出 | Node5 | `bel_locked_interest_expense = ifie_pnl_locked_interest` |
| 投资收益收入 | 投资台账 | `investment_return_income = investment_return` |
| OCI | Node5 | `oci = ifie_oci_discount_effect` |

### 8.3 净利润与综合收益总额
```text
net_income
= actual_claim_income
+ expected_claim_expense
+ csm_release_income
+ csm_interest_expense
+ bel_locked_interest_expense
+ investment_return_income
```

文字版：
- 净利润等于所有已经进入利润表的收入和支出项目逐项相加。
- 这里的支出项目本身就是负数，因此公式直接求和即可。

数字版示例（以 M1 为例）：

```text
net_income_M1 = 50 + (-50) + 0.64 + (-0.51) + (-2.50) + 0.58 = -1.79
```

```text
total_comprehensive_income = net_income + oci
```

文字版：
- 综合收益总额 = 净利润 + OCI。

数字版示例（以 M1 为例，若 `oci = 0`）：

```text
total_comprehensive_income_M1 = -1.79 + 0 = -1.79
```

### 8.4 时间窗口
- 月表：逐月
- 年表：Y1~Y5 采用逐月求和
- 报表展示时会跳过 M0，因此 `M1 = 原始第2行`

## 9. 后处理层 C：资产负债表（BS）组装
### 9.1 当前版本 BS 字段
当前代码输出以下项目：
- 再保险合同资产 - 应收分保佣金
- 再保险合同资产 - 应收摊回赔款
- 再保险合同资产 - 应付分出保费
- 再保险合同资产 - 应收分保准备金 - BEL @ CR
- 再保险合同资产 - 应收分保准备金 - CSM
- 金融资产（记录投资收益部分）
- 银行存款
- 资产汇总
- 负债汇总
- 净资产

### 9.2 BS 每个项目的来源
#### 1. 应收分保佣金
```text
reinsurance_contract_assets_commission_t = 累计 commission 至当期期末
```

数字版示例（以 M1 为例）：

```text
commission_asset_M1 = 200 + 0 = 200
```

#### 2. 应收摊回赔款
```text
reinsurance_contract_assets_claims_t = 累计 actual_claims 至当期期末
```

数字版示例（以 M1 为例）：

```text
claims_asset_M1 = 0 + 50 = 50
```

#### 3. 应付分出保费
```text
reinsurance_contract_assets_premiums_payable_t = 累计 actual_premiums 至当期期末
```

数字版示例（以 M1 为例）：

```text
premium_payable_M1 = 0 + (-100) = -100
```

#### 4. 应收分保准备金 - BEL @ CR
```text
reinsurance_contract_assets_bel_cr_t = bel_current_t - exp_net_cf_t
```

扣除 `exp_net_cf` 的原因是：
- `bel_current` 仍包含当期预期现金流
- 但最终期末 BS 需要剔除已经进入本期经营结果的这部分

数字版示例（以 M1 为例）：

```text
BEL@CR_M1 = -50 - (-50) = 0
```

#### 5. 应收分保准备金 - CSM
```text
reinsurance_contract_assets_csm_t = csm_closing_t
```

数字版示例（以 M1 为例）：

```text
CSM_asset_M1 = -151.87
```

#### 6. 金融资产（记录投资收益部分）
```text
financial_assets_investment_return_t = 累计 investment_return 至当期期末
```

数字版示例（以 M1 为例）：

```text
financial_asset_M1 = 0 + 0.58 = 0.58
```

#### 7. 银行存款
```text
cash_in_bank_t = 0
```

### 9.3 资产汇总、负债汇总、净资产
设 `items` 为上述 7 个项目，则：

```text
total_assets = 所有正数项之和
```

文字版：
- 所有正数项目加总为资产。

```text
total_liabilities = 所有负数项绝对值之和
```

文字版：
- 所有负数项目取绝对值后加总为负债。

```text
net_assets = total_assets - total_liabilities
```

文字版：
- 净资产 = 资产汇总 - 负债汇总。

数字版示例（以 M1 为例）：

```text
net_assets_M1 = (200 + 50 + 0.58) - (100 + 151.87) = -1.29
```

### 9.4 时间窗口
- 月表：逐月
- 年表：Y1~Y5 采用年末余额（不是 12 个月求和）

## 10. 报表展示层规则
### 10.1 PL 报表
- `M1`：取第一个经营月（原始第 2 行）
- `Y1~Y5`：取经营月口径的逐月求和

### 10.2 BS 报表
- `M1`：取第一个经营月期末余额
- `Y1~Y5`：取每个年度最后一个经营月的期末余额

### 10.3 BEL0
额外摘要项：
```text
BEL0 = node2[0].bel_current
```

这就是 M0 初始确认时点的当期 BEL。

## 11. 勾稽关系
### 11.1 PL 与 BS
当前实现要求：
```text
当期净资产变动 = 当期综合收益总额
```

为实现这一点，`BS` 中的 `BEL @ CR` 采用了：
```text
bel_current - exp_net_cf
```
而不是直接使用 `bel_current`。

### 11.2 CSM 与 PL
- `CSM计息` 进入 PL 支出
- `CSM释放` 进入 PL 收入
- `CSM期末余额` 进入 BS 的 CSM 项目

### 11.3 投资收益与 BS
- 当期投资收益进入 PL 收入
- 累计投资收益进入 BS 的金融资产项目

## 12. 单一测试案例端到端贯穿示例
### 12.1 测试案例输入
以下示例使用一组最小化输入，只为演示引擎链路：

| 原始行 | date | commission | expected_premiums | actual_premiums | expected_claims | actual_claims | expected_expenses | actual_expenses | df |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| M0 | 2026/1/1 | 200 | 0 | 0 | 0 | 0 | 0 | 0 | 1.0000 |
| M1 | 2026/2/1 | 0 | -100 | -100 | 50 | 50 | 0 | 0 | 0.9500 |
| M2 | 2026/3/1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.9964 |
| M3 | 2026/4/1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.9946 |

默认全局参数：
- `CSM计息率 = 4%`
- `CSM释放率 = 5%`
- `投资收益率 = 3.5%`
- `RA比例 = 0`

### 12.2 从 Input 到 Node 1
```text
exp_net_cf_M1 = 50 + 0 + 0 + (-100) = -50
act_net_cf_M1 = 50 + 0 + 0 + (-100) = -50
```

得到：
- `exp_net_cf_M1 = -50`
- `act_net_cf_M1 = -50`
- 各偏差均为 0

### 12.3 从 Node 1 到 Node 2
M0：
```text
BEL0(current) = 200 × 1 + (-50 × 0.95) = 152.50
BEL0(locked)  = 200 × 1 + (-50 × 0.95) = 152.50
```

M1：
```text
BEL_current_M1 = -50 × 1 = -50
BEL_locked_M1  = -50 × (0.95 / 0.95) = -50
delta_bel_M1   = -50 - (-50) = 0
```

### 12.4 从 Node 2 到 Node 4
因为 `RA = 0`：

```text
fcf_day1 = BEL0(current) + RA0 = 152.50 + 0 = 152.50
CSM0 = -fcf_day1 = -152.50
```

### 12.5 从 Node 4、Node 6 到 Node 7
本例中 `unlocking_to_csm = 0`，因此 CSM 只受计息和释放影响。

M1：
```text
csm_opening_M1 = -152.50
csm_interest_M1 = -152.50 × (4% / 12) = -0.51
csm_pre_amort_M1 = -152.50 - 0.51 + 0 = -153.01
csm_amortization_M1 = -153.01 × (5% / 12) = -0.64
csm_closing_M1 ≈ -152.37
```

### 12.6 从 Node 2 到 Node 5
M1：
```text
rate_M1 = 1 - 0.95 / 1 = 0.05
BEL_locked_interest_M1 = -50 × 0.05 = -2.50
OCI_M1 = delta_bel_M1 - delta_bel_M0 = 0 - 0 = 0
```

### 12.7 从现金流到投资台账
M0 不计投资收益，只建账：
```text
investment_assets_M0 = 200
```

M1：
```text
investment_base_M1 = 200
investment_return_M1 = 200 × (3.5% / 12) = 0.58
investment_assets_M1 = 200 + 0 + 50 + (-100) + 0 + 0.58 = 150.58
```

### 12.8 最终生成 PL（M1）
```text
实际赔付收入 = 50
预期赔付支出 = -50
CSM释放收入 = -(-0.64) = 0.64
CSM计息支出 = -0.51
BEL(锁定)计息支出 = -2.50
投资收益收入 = 0.58
净利润 = 50 - 50 + 0.64 - 0.51 - 2.50 + 0.58 = -1.79
综合收益总额 = -1.79 + 0 = -1.79
```

### 12.9 最终生成 BS（M1）
```text
应收分保佣金 = 200
应收摊回赔款 = 50
应付分出保费 = -100
BEL@CR = -50 - (-50) = 0
CSM = -151.87
金融资产 = 0.58
银行存款 = 0
```

再汇总：
```text
资产汇总 = 200 + 50 + 0.58 = 250.58
负债汇总 = 100 + 151.87 = 251.87
净资产 = 250.58 - 251.87 = -1.29
```

### 12.10 端到端示例的用途
这一节的作用有两个：
- 给开发和业务人员一条可以手工复核的最小链路
- 给大模型一个完整的“从输入到报表”的样板推导

## 13. 当前 Demo 的关键简化假设
1. 只有一条 `df` 曲线，`current` 与 `locked` 的差别来自调用方式，不来自输入曲线不同
2. RA 默认值为 0，但保留整条链路
3. 不展开真实 Loss Component 逻辑，`day1_loss_component` 当前固定为 0
4. `Node6` 中 `experience_to_pnl` 已计算，但未单独作为 PL 行项目输出
5. `unlocking_to_csm` 当前用 `premium variance` 代理 future-service remeasurement
6. `bank deposit` 当前固定为 0
7. 最终报表展示层跳过 M0，只从第一个经营月开始显示 `M1`

## 14. 建议作为大模型知识底座的调用方式
如果后续要把本文档喂给大模型，建议模型优先按下面顺序检索：
1. 先看第 3 章全局约定
2. 再看第 5 章总体链路
3. 如果用户问某个指标来源，先定位到对应 Node
4. 如果用户问最终报表项目，优先看第 8 章和第 9 章
5. 如果用户问为什么 PL/BS 不平，优先看第 11 章勾稽关系
6. 如果用户问完整算例，优先看第 12 章端到端贯穿示例

## 15. 结论
当前版本可以把整个引擎理解为：

`输入现金流与 df -> Node 1 现金流 -> Node 2 双 BEL -> Node 3 RA -> Node 4 初始 CSM -> Node 5 IFIE/OCI -> Node 6 偏差分类 -> Node 7 CSM roll-forward -> 投资台账 -> PL/BS`

其中：
- Node 0 到 Node 7 覆盖了全部核心计算因素
- 投资台账与 PL/BS 组装层负责把节点结果变成最终输出
- 因此，若后续要继续增强模型解释、问答、自动调参，本文档已经可以作为第一版知识底座使用
