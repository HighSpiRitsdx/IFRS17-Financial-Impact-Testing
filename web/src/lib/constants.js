export const GLOBAL_DEFAULTS = {
  csmAccretionRateAnnual: 0.04,
  csmAmortizationRateAnnual: 0.05,
  investmentReturnRate: 0.035,
};

export const NODE_DEFAULTS = {
  node0: {
    csmAccretionRateAnnual: 0.04,
    csmAmortizationRateAnnual: 0.05,
    investmentReturnRate: 0.035,
  },
  node1: {
    premiumMultiplier: 1,
    claimMultiplier: 1,
  },
  node2: {
    discountFineTune: 1,
  },
  node3: {
    raRatio: 0,
  },
  node4: {
    day1LossSwitch: 0,
  },
  node5: {
    ociImpactScale: 1,
  },
  node6: {
    claimVarianceWeight: 1,
    premiumVarianceWeight: 1,
  },
  node7: {
    csmReleaseScale: 1,
  },
};

export const GLOBAL_VARIABLE_LABELS = {
  csmAccretionRateAnnual: "CSM计息率",
  csmAmortizationRateAnnual: "CSM释放率",
  investmentReturnRate: "投资收益率",
};

export const NODE_VARIABLE_LABELS = {
  premiumMultiplier: "保费缩放系数",
  claimMultiplier: "赔付缩放系数",
  discountFineTune: "贴现微调系数",
  raRatio: "RA比例",
  day1LossSwitch: "首日亏损开关",
  ociImpactScale: "OCI影响系数",
  claimVarianceWeight: "赔付偏差权重",
  premiumVarianceWeight: "保费偏差权重",
  csmReleaseScale: "CSM释放缩放系数",
};

export const PERCENT_KEYS = ["csmAccretionRateAnnual", "csmAmortizationRateAnnual", "investmentReturnRate", "raRatio"];

export const SCENARIO_KEY_LABELS = {
  csmAccretionRateAnnual: "CSM计息率",
  csmAmortizationRateAnnual: "CSM释放率",
  investmentReturnRate: "投资收益率",
  "node1.premiumMultiplier": "保费缩放系数",
  "node1.claimMultiplier": "赔付缩放系数",
  "node2.discountFineTune": "贴现微调系数",
  "node3.raRatio": "RA比例",
  "node4.day1LossSwitch": "首日亏损开关",
  "node5.ociImpactScale": "OCI影响系数",
  "node6.claimVarianceWeight": "赔付偏差权重",
  "node6.premiumVarianceWeight": "保费偏差权重",
  "node7.csmReleaseScale": "CSM释放缩放系数",
};

export const NODE_TITLES = {
  node0: "Node 0: 全局参数与曲线",
  node1: "Node 1: 现金流台账与偏差",
  node2: "Node 2: 双重 BEL 调用",
  node3: "Node 3: 风险调整 (RA)",
  node4: "Node 4: 初始确认与首日损益",
  node5: "Node 5: 保险财务收支 (IFIE)",
  node6: "Node 6: 经验偏差与 CSM 解锁",
  node7: "Node 7: CSM 摊销与利润呈现",
};

export const NODE_EXPLANATIONS = {
  node0: "设置单条 df 曲线、CSM 计息率、CSM 释放率与投资收益率。",
  node1: "输入值已自带最终符号，净现金流直接按各列求和。",
  node2: "Current BEL 每期重置 df 起点，Locked BEL 沿绝对月份继续调用同一条 df。",
  node3: "记录 RA 期初/期末余额，并计算当期 RA 释放。",
  node4: "首日执行盈利性测试：FCF<0 建立 CSM；FCF>0 形成首日亏损。",
  node5: "锁定 BEL 计息进入利润表支出，BEL 差异的当期变动进入 OCI。",
  node6: "claim 偏差和 expense 偏差留作经验分析，premium 偏差通过 CSM 解锁影响利润。",
  node7: "按照 IFRS 17 收入确认逻辑构建利润表，同时滚动投资资产。",
};

export const NODE_FORMULAS = {
  node0: [
    "DF_t: 第 t 期折现因子曲线",
    "i_csm: CSM 计息率（默认 4.00%）",
    "alpha_csm: CSM 释放率（默认 5.00%）",
    "r_inv: 投资收益率（默认 3.50%）",
  ],
  node1: [
    "E(Net_CF_t) = E(Claim_t) + E(Expense_t) + Commission_t + E(Premium_t)",
    "A(Net_CF_t) = A(Claim_t) + A(Expense_t) + Commission_t + A(Premium_t)",
    "所有输入值已带最终正负号，系统直接求和",
  ],
  node2: [
    "BEL_current(T) = Sum[期末现金流 x DF(k) + 期初 Commission x DF(k-1)]",
    "BEL_locked(T) = Sum[期末现金流 x DF(t) + 期初 Commission x DF(t-1)]",
    "Claim / Premium / Expense 视作期末，Commission 视作期初",
  ],
  node3: [
    "RA_release = RA_BOP - RA_EOP + RA_interest",
    "Demo 阶段 RA 默认取 0，但链路完整保留",
  ],
  node4: [
    "FCF_Day1 = BEL_current,Day1 + RA_Day1",
    "CSM0 = -BEL0（若含 RA，则为 -(BEL0 + RA0)）",
    "本版本不单独展开首日亏损组件，默认 Day1 Loss = 0",
  ],
  node5: [
    "BEL_locked_interest = 当期 BEL_locked x (1 - 当期DF / 上期DF)",
    "OCI_period = Delta BEL_financial,EOP - Delta BEL_financial,BOP",
  ],
  node6: [
    "Experience = Delta Claim + Delta Expense",
    "Delta CSM_unlocking = Delta Premium（Demo 代理 future-service remeasurement）",
  ],
  node7: [
    "CSM_pre_release = CSM_BOP + CSM_interest + Delta CSM_unlocking",
    "CSM_release = CSM_pre_release x alpha_csm",
    "PL 中收入项为正、支出项为负：预期赔付/CSM计息/BEL锁定计息均展示为负数",
  ],
};

export const NODE_EXAMPLE_CONFIGS = {
  node0: {
    inputColumns: ["date", "df"],
    formulaLabel: "读取单条 df 曲线并广播给后续节点",
    outputColumns: ["df"],
  },
  node1: {
    inputColumns: ["expected_claims", "expected_expenses", "commission", "expected_premiums"],
    formulaLabel: "预期赔付 + 预期费用 + 佣金 + 预期保费（输入值已带正负号）",
    outputColumns: ["exp_net_cf", "var_claim", "var_expense", "var_premium"],
  },
  node2: {
    inputColumns: ["expected_claims", "expected_expenses", "commission", "expected_premiums", "df"],
    formulaLabel: "Current 每期重置 df 起点；Locked 按绝对时点滚动；Commission 用上一档 DF",
    outputColumns: ["bel_locked", "bel_current", "delta_bel"],
  },
  node3: {
    inputColumns: ["bel_current"],
    formulaLabel: "RA_release = RA_BOP - RA_EOP + RA_interest",
    outputColumns: ["ra_opening", "ra_interest", "ra_release", "ra_closing"],
  },
  node4: {
    inputColumns: ["bel_current", "ra_opening"],
    formulaLabel: "CSM0 = -BEL0；本版本不单独展开首日亏损组件",
    outputColumns: ["fcf_day1", "initial_csm", "day1_loss_component"],
  },
  node5: {
    inputColumns: ["bel_locked", "delta_bel", "df"],
    formulaLabel: "BEL_locked 计息进 P&L；Current/Locked 差异的期间变动进 OCI",
    outputColumns: ["ifie_pnl_locked_interest", "ifie_oci_discount_effect"],
  },
  node6: {
    inputColumns: ["var_claim", "var_expense", "var_premium"],
    formulaLabel: "claim/expense 偏差用于经验分析，premium 偏差通过 CSM 解锁",
    outputColumns: ["experience_to_pnl", "unlocking_to_csm"],
  },
  node7: {
    inputColumns: ["csm_opening", "csm_interest", "unlocking_to_csm", "investment_base"],
    formulaLabel: "CSM期初 -> CSM计息 -> CSM释放 -> CSM期末，并映射到IFRS17利润表",
    outputColumns: ["csm_pre_amort", "csm_amortization", "csm_closing", "investment_return", "investment_assets"],
  },
};

export const FIELD_LABELS = {
  report_period: "期间",
  actual_claim_income: "实际赔付收入",
  expected_claim_expense: "预期赔付支出",
  csm_release_income: "CSM释放收入",
  csm_interest_expense: "CSM计息支出",
  bel_locked_interest_expense: "BEL(锁定)计息支出",
  investment_return_income: "投资收益收入",
  investment_return: "投资收益",
  investment_base: "投资计息基础",
  investment_assets: "投资资产余额",
  oci: "其他综合收益(OCI)",
  net_income: "净利润",
  total_comprehensive_income: "综合收益总额",
  bel_current: "BEL(当期)",
  bel_locked: "BEL(锁定)",
  delta_bel: "BEL差异",
  reinsurance_contract_assets_commission: "再保险合同资产 - 应收分保佣金",
  reinsurance_contract_assets_claims: "再保险合同资产 - 应收摊回赔款",
  reinsurance_contract_assets_premiums_payable: "再保险合同资产 - 应付分出保费",
  reinsurance_contract_assets_bel_cr: "再保险合同资产 - 应收分保准备金 - BEL @ CR（扣除当期预期净现金流）",
  reinsurance_contract_assets_csm: "再保险合同资产 - 应收分保准备金 - CSM",
  financial_assets_investment_return: "金融资产（记录投资收益部分）",
  cash_in_bank: "银行存款",
  total_assets: "资产汇总",
  total_liabilities: "负债汇总",
  net_assets: "净资产",
  ra_opening: "RA期初余额",
  ra_interest: "RA利息增生",
  ra_release: "RA当期释放",
  ra_closing: "RA期末余额",
  fcf_day1: "首日FCF",
  initial_csm: "初始CSM",
  day1_loss_component: "首日亏损组件",
  csm_closing: "CSM期末余额",
  insurance_contract_liability: "保险合同负债",
  exp_net_cf: "预期净现金流",
  act_net_cf: "实际净现金流",
  var_premium: "保费偏差",
  var_claim: "赔付偏差",
  var_expense: "费用偏差",
  ifie_pnl_locked_interest: "BEL锁定计息",
  ifie_oci_discount_effect: "OCI当期发生额",
  experience_to_pnl: "经验偏差分析值",
  unlocking_to_csm: "解锁至CSM",
  csm_opening: "CSM期初",
  csm_interest: "CSM计息",
  csm_pre_amort: "CSM摊销前",
  csm_amortization: "CSM释放",
  expected_premiums: "预期保费",
  actual_premiums: "实际保费",
  expected_claims: "预期赔付",
  actual_claims: "实际赔付",
  expected_expenses: "预期费用",
  actual_expenses: "实际费用",
  commission: "佣金",
  df: "折现因子(df)",
  formula_text: "计算公式",
  date: "日期",
  month_index: "月序号",
};

export const HIDE_COLUMNS = ["date", "month_index"];








export const NODE_TARGETS = {
  node0: "定义全局折现、CSM 和投资收益参数，作为后续节点统一输入。",
  node1: "得到预期/实际净现金流与经验偏差，作为 BEL、CSM 解锁和利润归因的基础。",
  node2: "计算当期与锁定两套 BEL，并识别财务差异。",
  node3: "形成 RA 的期初、释放和期末框架，当前 Demo 默认值为 0。",
  node4: "在初始确认时点建立 CSM0，并保留 Day 1 的建账结果。",
  node5: "把锁定 BEL 计息和 OCI 当期发生额拆分出来，用于 PL 与 OCI。",
  node6: "把经验偏差按规则分类到经营结果或 CSM 解锁。",
  node7: "滚动 CSM、投资资产，并生成可进入 PL/BS 的经营结果。",
};

export const NODE_FORMULA_DETAILS = {
  node0: [
    { latex: 'DF_t', explanation: '第 t 期折现因子曲线，用于 Node 2 的现值计算。' },
    { latex: 'i_{csm}', explanation: 'CSM 月度计息率的年化输入，系统内部按 12 分摊。' },
    { latex: '\\alpha_{csm}', explanation: 'CSM 释放率，用于经营月的 CSM 释放。' },
    { latex: 'r_{inv}', explanation: '投资收益率，用于投资计息基础滚动投资收益。' },
  ],
  node1: [
    { latex: 'E(Net\\_CF_t)=E(Claim_t)+E(Expense_t)+Commission_t+E(Premium_t)', explanation: '预期净现金流，输入值本身已带正负号。' },
    { latex: 'A(Net\\_CF_t)=A(Claim_t)+A(Expense_t)+Commission_t+A(Premium_t)', explanation: '实际净现金流，用于经验分析和经营结果。' },
    { latex: '\\Delta CF_t = A(Net\\_CF_t)-E(Net\\_CF_t)', explanation: '经验偏差，用于 Node 6 做分类。' },
  ],
  node2: [
    { latex: 'BEL^{current}_t=\\sum CF^{EOP}_{t+k}\\times DF_k+Commission^{BOP}_{t+k}\\times DF_{k-1}', explanation: 'Current BEL 每期都从曲线起点重新调用 df。' },
    { latex: 'BEL^{locked}_t=\\sum CF^{EOP}_{t+k}\\times \\frac{DF_{t+k}}{DF_t}+Commission^{BOP}_{t+k}\\times \\frac{DF_{t+k-1}}{DF_{t-1}}', explanation: 'Locked BEL 反映当期锁定口径状态，而不是一直停留在 M0。' },
    { latex: '\\Delta BEL_t=BEL^{current}_t-BEL^{locked}_t', explanation: '财务差异进入 OCI 分析。' },
  ],
  node3: [
    { latex: 'RA_{release}=RA_{BOP}-RA_{EOP}+RA_{interest}', explanation: 'RA 释放进入利润表，当前 Demo 默认 RA 为 0。' },
  ],
  node4: [
    { latex: 'FCF_0 = BEL_0 + RA_0', explanation: '首日履约现金流，当前 Demo 的 RA 为 0。' },
    { latex: 'CSM_0 = -BEL_0', explanation: '在当前口径下，初始 CSM 直接对冲 BEL0。' },
  ],
  node5: [
    { latex: 'Interest_t = BEL^{locked}_t \\times (1-\\frac{DF_t}{DF_{t-1}})', explanation: '首行不计息，从首个经营月开始使用当期 BEL(锁定) 和当期/上期 df。' },
    { latex: 'OCI_t = \\Delta BEL_t-\\Delta BEL_{t-1}', explanation: 'OCI 反映当期财务差异的新增部分。' },
  ],
  node6: [
    { latex: 'Experience_t = \\Delta Claim_t + \\Delta Expense_t', explanation: '经验偏差保留用于经营结果诊断。' },
    { latex: '\\Delta CSM^{unlock}_t = \\Delta Premium_t', explanation: 'Demo 版本用 premium variance 代理 future-service unlocking。' },
  ],
  node7: [
    { latex: 'CSM^{open}_t = CSM^{close}_{t-1}', explanation: '首个经营月以前一行建账得到的 CSM0 作为期初。' },
    { latex: 'CSM^{interest}_t = CSM^{open}_t \\times i_{csm}', explanation: '从首个经营月开始计提 CSM 利息。' },
    { latex: 'CSM^{release}_t=(CSM^{open}_t+CSM^{interest}_t+\\Delta CSM^{unlock}_t)\\times \\alpha_{csm}', explanation: 'CSM 释放进入利润表收入。' },
    { latex: 'Investment\\ Base_t = Opening\\ Assets_t + Commission_t', explanation: '首行如果只有 commission，则该行不计息，从下一经营月开始滚动。' },
    { latex: 'Investment\\ Return_t = Investment\\ Base_t \\times \\frac{r_{inv}}{12}', explanation: '投资收益进入利润表，同时累计到金融资产。' },
  ],
};
