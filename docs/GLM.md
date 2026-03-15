# IFRS17 引擎知识底稿（GLM）

## 1. 使用目的
本文件是给大模型问答使用的精简知识底稿，只保留当前系统实际实现的核心计算逻辑。

完整链路：
`Input -> Node0~7 -> Asset Ledger -> PL -> BS -> 展示层`

## 2. 核心口径
### 2.1 输入符号
输入值自带最终符号，不再二次翻转：
- `commission`：通常为正，表示期初收到的佣金
- `premium`：通常为负，表示分出保费支出
- `claim`：通常为正，表示摊回赔款收入
- `expense`：当前多为 0

### 2.2 时点
- `commission`：期初现金流（BOP）
- `premium / claim / expense`：期末现金流（EOP）

### 2.3 折现因子
系统只有一条 `df` 曲线：
- `BEL(current)`：每个月都从曲线起点重新调用
- `BEL(locked)`：从当期位置继续沿同一条曲线往后调用

### 2.4 展示口径
- `M0`：原始输入第 1 行，只用于初始确认和建账
- `M1`：原始输入第 2 行，即首个经营月
- `PL` 年表：年度内逐月求和
- `BS` 年表：取年末余额

## 3. 输入字段
### 3.1 必填
- `date`
- `expected_premiums`
- `actual_premiums`
- `expected_claims`
- `actual_claims`
- `commission`
- `df`

### 3.2 选填
- `expected_expenses`，默认 0
- `actual_expenses`，默认 0

## 4. Node 0 到 Node 7

## Node 0：全局参数
负责定义：
- `df`
- `CSM计息率`
- `CSM释放率`
- `投资收益率`

当前默认值：
- `CSM计息率 = 4%`
- `CSM释放率 = 5%`
- `投资收益率 = 3.5%`

## Node 1：净现金流与偏差
### 输出
- `exp_net_cf`
- `act_net_cf`
- `var_premium`
- `var_claim`
- `var_expense`
- `var_net_cf`

### 公式
```text
exp_net_cf_t = expected_claims_t + expected_expenses_t + commission_t + expected_premiums_t
act_net_cf_t = actual_claims_t + actual_expenses_t + commission_t + actual_premiums_t
```

```text
var_premium_t = actual_premiums_t - expected_premiums_t
var_claim_t   = actual_claims_t - expected_claims_t
var_expense_t = actual_expenses_t - expected_expenses_t
var_net_cf_t  = act_net_cf_t - exp_net_cf_t
```

### 说明
- Node 1 只整理现金流和偏差，不做贴现，不做利润确认。

## Node 2：双 BEL
### 输出
- `bel_current`
- `bel_locked`
- `delta_bel`

### 先定义现金流
```text
EOP_Flow_t = expected_claims_t + expected_expenses_t + expected_premiums_t
BOP_Flow_t = commission_t
```

### BEL(current)
```text
BEL_current_t = Sum_{j=t..N}[EOP_Flow_j × df_{j-t}] + Sum_{j=t..N}[commission_j × df_{j-t-1}]
```

文字版：
- 从当前月重新开始，向后看所有未来现金流。
- 期末现金流用 `df_{j-t}`。
- 佣金按期初属性用 `df_{j-t-1}`。

### BEL(locked)
```text
BEL_locked_t = Sum_{j=t..N}[EOP_Flow_j × (df_j / df_t)] + Sum_{j=t..N}[commission_j × (df_{j-1} / df_{t-1})]
```

文字版：
- 从当期位置继续滚动，不重置曲线起点。
- 期末现金流用 `df_j / df_t`。
- 佣金用 `df_{j-1} / df_{t-1}`。

### 财务差异
```text
delta_bel_t = bel_current_t - bel_locked_t
```

## Node 3：RA
### 输出
- `ra_opening`
- `ra_interest`
- `ra_release`
- `ra_closing`

### 公式
```text
ra_opening_t = |bel_current_t| × raRatio
ra_closing_t = |bel_current_{t+1}| × raRatio
ra_interest_t = ra_opening_t × (df_{t-1} / df_t - 1)
ra_release_t = ra_opening_t - ra_closing_t + ra_interest_t
```

### 说明
- 当前 Demo 中 `raRatio = 0`，所以 RA 链路存在，但数值通常为 0。

## Node 4：初始确认与首日 CSM
### 输出
- `fcf_day1`
- `initial_csm`
- `day1_loss_component`

### 公式
```text
fcf_day1 = bel_current_0 + ra_opening_0
initial_csm_0 = -fcf_day1
day1_loss_component = 0
```

### 说明
- 当前 Demo 采用 `CSM0 = -BEL0` 的实现思路。
- 首日亏损组件暂时固定为 0。

## Node 5：IFIE 与 OCI
### 输出
- `ifie_pnl_locked_interest`
- `ifie_oci_discount_effect`

### BEL(locked)计息
```text
rate_t = 1 - df_t / df_{t-1}
BEL_locked_interest_t = bel_locked_t × rate_t
```

文字版：
- 用当期 `BEL(locked)` 乘以贴现因子从上期到本期的回拨比例。
- M0 不计息。

### OCI
```text
OCI_t = if t = 0 then delta_bel_t else delta_bel_t - delta_bel_{t-1}
```

文字版：
- OCI 取 `delta_bel` 的期间变动。

## Node 6：经验偏差与 CSM unlocking
### 输出
- `experience_to_pnl`
- `unlocking_to_csm`

### 公式
```text
experience_to_pnl_t = var_claim_t × claimVarianceWeight + var_expense_t
unlocking_to_csm_t = var_premium_t × premiumVarianceWeight
```

### 说明
- 当前 Demo 用 `premium variance` 代理 future-service remeasurement。
- `experience_to_pnl` 已算出，但没有单独拉成最终 PL 行项目。

## Node 7：CSM Roll-forward
### 输出
- `csm_opening`
- `csm_interest`
- `csm_pre_amort`
- `csm_amortization`
- `csm_closing`

### 参数
```text
i_csm = csmAccretionRateAnnual / 12
alpha_csm = csmAmortizationRateAnnual / 12 × csmReleaseScale
```

### 公式
```text
csm_opening_t = if t = 0 then initial_csm_0 else csm_closing_{t-1}
csm_interest_t = if t = 0 then 0 else csm_opening_t × i_csm
csm_pre_amort_t = csm_opening_t + csm_interest_t + unlocking_to_csm_t
csm_amortization_t = if t = 0 then 0 else csm_pre_amort_t × alpha_csm
csm_closing_t = csm_pre_amort_t - csm_amortization_t
```

### 说明
- M0 只建 CSM，不计息、不释放。
- M1 起正常滚动。
- 最终 PL 中，`CSM释放收入 = -csm_amortization`。

## 5. Asset Ledger
### 输出
- `investment_base`
- `investment_return`
- `investment_assets`

### 公式
```text
investment_assets_opening_t = if t = 0 then 0 else investment_assets_{t-1}
investment_base_t = if t = 0 then max(opening_t, 0) else max(opening_t + commission_t, 0)
investment_return_t = if t = 0 then 0 else investment_base_t × (investmentReturnRate / 12)
investment_assets_t = opening_t + commission_t + actual_claims_t + actual_premiums_t + actual_expenses_t + investment_return_t
```

### 说明
- `commission` 当期参与投资计息。
- `claim / premium / expense` 当期不参与计息，只进入期末资产。
- M0 只建账，不计投资收益。

## 6. 利润表（PL）
### 当前输出项目
- `actual_claim_income`
- `expected_claim_expense`
- `csm_release_income`
- `csm_interest_expense`
- `bel_locked_interest_expense`
- `investment_return_income`
- `oci`
- `net_income`
- `total_comprehensive_income`

### 行项目来源
```text
actual_claim_income = actual_claims
expected_claim_expense = -expected_claims
csm_release_income = -csm_amortization
csm_interest_expense = csm_interest
bel_locked_interest_expense = ifie_pnl_locked_interest
investment_return_income = investment_return
oci = ifie_oci_discount_effect
```

### 净利润
```text
net_income = actual_claim_income
           + expected_claim_expense
           + csm_release_income
           + csm_interest_expense
           + bel_locked_interest_expense
           + investment_return_income
```

### 综合收益总额
```text
total_comprehensive_income = net_income + oci
```

## 7. 资产负债表（BS）
### 当前输出项目
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

### 各项目公式
```text
应收分保佣金 = 累计 commission 至当期期末
应收摊回赔款 = 累计 actual_claims 至当期期末
应付分出保费 = 累计 actual_premiums 至当期期末
BEL @ CR = bel_current_t - exp_net_cf_t
CSM = csm_closing_t
金融资产 = 累计 investment_return 至当期期末
银行存款 = 0
```

### 汇总规则
```text
total_assets = 所有正数项之和
total_liabilities = 所有负数项绝对值之和
net_assets = total_assets - total_liabilities
```

## 8. 勾稽关系
### 8.1 PL 与 BS
系统要求：
```text
当期净资产变动 = 当期综合收益总额
```

为保证这条勾稽成立，BS 中使用：
```text
BEL @ CR = bel_current - exp_net_cf
```
而不是直接使用 `bel_current`。

### 8.2 CSM 与报表
- `CSM计息`：进入 PL 支出
- `CSM释放`：进入 PL 收入
- `CSM期末余额`：进入 BS 的 CSM 项目

### 8.3 投资收益与报表
- 当期投资收益：进入 PL 收入
- 累计投资收益：进入 BS 的金融资产项目

## 9. 最小端到端示例
### 输入
| 原始行 | commission | expected_premiums | actual_premiums | expected_claims | actual_claims | df |
|---|---:|---:|---:|---:|---:|---:|
| M0 | 200 | 0 | 0 | 0 | 0 | 1.0000 |
| M1 | 0 | -100 | -100 | 50 | 50 | 0.9500 |
| M2 | 0 | 0 | 0 | 0 | 0 | 0.9964 |

### 关键结果
```text
Node1:
exp_net_cf_M1 = 50 + 0 + 0 + (-100) = -50

Node2:
BEL0 = 200 × 1 + (-50 × 0.95) = 152.50
BEL_current_M1 = -50
BEL_locked_M1 = -50

Node4:
CSM0 = -BEL0 = -152.50

Node5:
rate_M1 = 1 - 0.95 / 1 = 0.05
BEL_locked_interest_M1 = -50 × 0.05 = -2.50
OCI_M1 = 0

Node7:
CSM interest_M1 = -152.50 × (4%/12) ≈ -0.51
CSM amortization_M1 = (-152.50 - 0.51) × (5%/12) ≈ -0.64

Asset Ledger:
investment_return_M1 = 200 × (3.5%/12) = 0.58

PL:
net_income_M1 = 50 - 50 + 0.64 - 0.51 - 2.50 + 0.58 = -1.79

BS:
BEL@CR_M1 = -50 - (-50) = 0
net_assets_M1 = (200 + 50 + 0.58) - (100 + 151.87) = -1.29
```

## 10. 当前 Demo 的简化项
1. 只有一条 `df` 曲线。
2. RA 默认值为 0。
3. `day1_loss_component` 固定为 0。
4. `experience_to_pnl` 已计算，但未单独进入最终 PL 行。
5. `unlocking_to_csm` 当前用 `premium variance` 代理。
6. `bank deposit = 0`。
7. 展示层跳过 M0，只从首个经营月开始显示 M1。

## 11. 给大模型的使用规则
问答时优先顺序：
1. 先定位用户问的是 Input、Node、PL、BS 还是勾稽
2. 如果问指标来源，先回答它来自哪个 Node 或后处理层
3. 如果问如何计算，优先给公式和文字解释
4. 如果超出本文档定义，明确回答“当前系统未定义”
