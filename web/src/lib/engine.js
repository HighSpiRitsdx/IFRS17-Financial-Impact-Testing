const REQUIRED_COLUMNS = [
  "date",
  "expected_premiums",
  "actual_premiums",
  "expected_claims",
  "actual_claims",
  "commission",
  "df",
];

const OPTIONAL_COLUMNS = ["expected_expenses", "actual_expenses"];

const COLUMN_ALIASES = {
  $date: "date",
  dt: "date",
  expectedpremium: "expected_premiums",
  actualpremium: "actual_premiums",
  expectedclaim: "expected_claims",
  actualclaim: "actual_claims",
  expectedexpense: "expected_expenses",
  actualexpense: "actual_expenses",
  commission: "commission",
  commissions: "commission",
  df: "df",
  discountfactor: "df",
  lockeddf: "df",
  currentdf: "df",
  lockedcurve: "df",
  currentcurve: "df",
};

export function runEngine(rawRows, vars, nodeOverrides = {}) {
  const base = prepare(rawRows, nodeOverrides);
  const node1 = calcNode1(base);
  const node2 = calcNode2(node1, nodeOverrides.node2 || {});
  const node3 = calcNode3(node2, nodeOverrides.node3 || {});
  const node4 = calcNode4(node3);
  const node5 = calcNode5(node4, nodeOverrides.node5 || {});
  const node6 = calcNode6(node5, nodeOverrides.node6 || {});
  const node7 = calcNode7(node6, vars, nodeOverrides.node7 || {});
  const assetLedger = buildAssetLedger(node7, vars);

  const mergedNodeOutputs = node7.map((row, index) => ({ ...row, ...assetLedger[index] }));
  const plMonthly = buildPL(mergedNodeOutputs);
  const bsMonthly = buildBS(mergedNodeOutputs);

  return {
    inputs: base,
    summary: {
      bel0: round2(node2[0]?.bel_current ?? 0),
    },
    nodeTables: {
      node0: base,
      node1,
      node2,
      node3,
      node4,
      node5,
      node6,
      node7: mergedNodeOutputs,
    },
    nodeOutputs: mergedNodeOutputs,
    plMonthly,
    bsMonthly,
    plReport: buildFlowReport(plMonthly),
    bsReport: buildStockReport(bsMonthly),
  };
}

export function findChangedVariables(globalVars, globalDefaults, nodeOverrides, nodeDefaults) {
  const changed = [];
  Object.keys(globalDefaults).forEach((key) => {
    if (Number(globalVars[key]) !== Number(globalDefaults[key])) changed.push({ key, value: globalVars[key] });
  });
  Object.entries(nodeDefaults).forEach(([node, defaults]) => {
    if (node === "node0") return;
    const current = nodeOverrides[node] || {};
    Object.keys(defaults).forEach((key) => {
      if (Number(current[key]) !== Number(defaults[key])) changed.push({ key: `${node}.${key}`, value: current[key] });
    });
  });
  return changed;
}

function normalizeHeader(header) {
  if (!header) return "";
  const raw = String(header).replace("\ufeff", "").trim();
  const base = raw.toLowerCase().replace(/[-_\s]/g, "");
  return COLUMN_ALIASES[base] || raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function prepare(rows, nodeOverrides) {
  const normalized = rows.map((row) => {
    const out = {};
    Object.keys(row).forEach((key) => {
      out[normalizeHeader(key)] = row[key];
    });
    return out;
  });

  const sample = normalized[0] || {};
  const missing = REQUIRED_COLUMNS.filter((column) => !(column in sample));
  if (missing.length) {
    throw new Error(`缺少必要字段: ${missing.join(", ")}`);
  }

  const node1 = nodeOverrides.node1 || {};
  const premiumMultiplier = Number(node1.premiumMultiplier ?? 1);
  const claimMultiplier = Number(node1.claimMultiplier ?? 1);

  const clean = normalized
    .map((row) => ({
      date: parseDate(row.date),
      expected_premiums: num(row.expected_premiums) * premiumMultiplier,
      actual_premiums: num(row.actual_premiums) * premiumMultiplier,
      expected_claims: num(row.expected_claims) * claimMultiplier,
      actual_claims: num(row.actual_claims) * claimMultiplier,
      expected_expenses: num(row.expected_expenses),
      actual_expenses: num(row.actual_expenses),
      commission: num(row.commission),
      df: num(row.df),
    }))
    .sort((a, b) => a.date - b.date)
    .map((row, index) => ({ ...row, month_index: index + 1 }));

  linearInterpolate(clean, "df");
  return clean;
}

function calcNode1(rows) {
  return rows.map((row) => {
    const expNet = row.expected_claims + row.expected_expenses + row.commission + row.expected_premiums;
    const actNet = row.actual_claims + row.actual_expenses + row.commission + row.actual_premiums;
    return {
      ...row,
      exp_net_cf: expNet,
      act_net_cf: actNet,
      var_premium: row.actual_premiums - row.expected_premiums,
      var_claim: row.actual_claims - row.expected_claims,
      var_expense: row.actual_expenses - row.expected_expenses,
      var_net_cf: actNet - expNet,
    };
  });
}

function getDfAt(dfs, index) {
  if (index < 0) return 1;
  if (index >= dfs.length) return dfs[dfs.length - 1] ?? 1;
  return dfs[index];
}

function getExpectedEndOfPeriodFlow(row) {
  return row.expected_claims + row.expected_expenses + row.expected_premiums;
}

function pvCurrentReset(rows, dfs) {
  const out = new Array(rows.length).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    let pv = 0;
    for (let j = i; j < rows.length; j += 1) {
      const curveIndex = j - i;
      const endDf = getDfAt(dfs, curveIndex);
      const bopDf = getDfAt(dfs, curveIndex - 1);
      pv += getExpectedEndOfPeriodFlow(rows[j]) * endDf;
      pv += rows[j].commission * bopDf;
    }
    out[i] = pv;
  }
  return out;
}

function pvLocked(rows, dfs) {
  const out = new Array(rows.length).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    let pv = 0;
    const currentEopAnchor = getDfAt(dfs, i);
    const currentBopAnchor = getDfAt(dfs, i - 1);
    for (let j = i; j < rows.length; j += 1) {
      const endDf = currentEopAnchor !== 0 ? getDfAt(dfs, j) / currentEopAnchor : 0;
      const bopDf = currentBopAnchor !== 0 ? getDfAt(dfs, j - 1) / currentBopAnchor : 0;
      pv += getExpectedEndOfPeriodFlow(rows[j]) * endDf;
      pv += rows[j].commission * bopDf;
    }
    out[i] = pv;
  }
  return out;
}

function calcNode2(rows, node2) {
  const fine = Number(node2.discountFineTune ?? 1);
  const dfs = rows.map((row) => row.df * fine);

  const belCurrent = pvCurrentReset(rows, dfs);
  const belLocked = pvLocked(rows, dfs);

  return rows.map((row, index) => ({
    ...row,
    bel_current: belCurrent[index],
    bel_locked: belLocked[index],
    delta_bel: belCurrent[index] - belLocked[index],
  }));
}

function calcNode3(rows, node3) {
  const raRatio = Number(node3.raRatio ?? 0);

  return rows.map((row, index) => {
    const raBop = Math.abs(row.bel_current) * raRatio;
    const raEop = index < rows.length - 1 ? Math.abs(rows[index + 1].bel_current) * raRatio : 0;
    const rate = index > 0 && row.df !== 0 ? rows[index - 1].df / row.df - 1 : 0;
    const raInterest = raBop * rate;
    const raRelease = raBop - raEop + raInterest;

    return {
      ...row,
      ra_opening: raBop,
      ra_interest: raInterest,
      ra_release: raRelease,
      ra_closing: raEop,
    };
  });
}

function calcNode4(rows) {
  return rows.map((row, index) => {
    const fcf = index === 0 ? row.bel_current + row.ra_opening : 0;
    return {
      ...row,
      fcf_day1: fcf,
      day1_loss_component: 0,
      initial_csm: index === 0 ? -fcf : 0,
    };
  });
}

function calcNode5(rows, node5) {
  const ociScale = Number(node5.ociImpactScale ?? 1);
  return rows.map((row, index) => {
    const rate = index > 0 && rows[index - 1].df !== 0 ? 1 - row.df / rows[index - 1].df : 0;
    const interest = index > 0 ? row.bel_locked * rate : 0;
    const oci = index === 0 ? row.delta_bel : row.delta_bel - rows[index - 1].delta_bel;

    return {
      ...row,
      ifie_pnl_locked_interest: interest,
      ifie_oci_discount_effect: oci * ociScale,
    };
  });
}

function calcNode6(rows, node6) {
  const claimWeight = Number(node6.claimVarianceWeight ?? 1);
  const premiumWeight = Number(node6.premiumVarianceWeight ?? 1);

  return rows.map((row) => ({
    ...row,
    experience_to_pnl: row.var_claim * claimWeight + row.var_expense,
    unlocking_to_csm: row.var_premium * premiumWeight,
  }));
}

function calcNode7(rows, vars, node7) {
  const out = [];
  const accretionRate = Number(vars.csmAccretionRateAnnual ?? 0) / 12;
  const amortizationRate = (Number(vars.csmAmortizationRateAnnual ?? 0) / 12) * Number(node7.csmReleaseScale ?? 1);

  rows.forEach((row, index) => {
    const opening = index === 0 ? row.initial_csm : out[index - 1].csm_closing;
    const interest = index === 0 ? 0 : opening * accretionRate;
    const preAmort = opening + interest + row.unlocking_to_csm;
    const amort = index === 0 ? 0 : preAmort * amortizationRate;
    const closing = preAmort - amort;

    out.push({
      ...row,
      csm_opening: opening,
      csm_interest: interest,
      csm_pre_amort: preAmort,
      csm_amortization: amort,
      csm_closing: closing,
    });
  });

  return out;
}

function buildAssetLedger(rows, vars) {
  const rate = Number(vars.investmentReturnRate ?? 0) / 12;
  const out = [];

  rows.forEach((row, index) => {
    const opening = index === 0 ? 0 : out[index - 1].investment_assets;
    const investableBase = index === 0 ? Math.max(opening, 0) : Math.max(opening + row.commission, 0);
    const investmentReturn = index === 0 ? 0 : investableBase * rate;
    const closing = opening + row.commission + row.actual_claims + row.actual_premiums + row.actual_expenses + investmentReturn;

    out.push({
      investment_base: investableBase,
      investment_return: investmentReturn,
      investment_assets: closing,
    });
  });

  return out;
}

function buildPL(rows) {
  return rows.map((row) => {
    const actualClaimIncome = row.actual_claims;
    const expectedClaimExpense = -row.expected_claims;
    const csmReleaseIncome = -row.csm_amortization;
    const csmInterestExpense = row.csm_interest;
    const belLockedInterestExpense = row.ifie_pnl_locked_interest;
    const investmentReturnIncome = row.investment_return;
    const netIncome =
      actualClaimIncome + expectedClaimExpense + csmReleaseIncome + csmInterestExpense + belLockedInterestExpense + investmentReturnIncome;

    return {
      date: row.date,
      month_index: row.month_index,
      actual_claim_income: round2(actualClaimIncome),
      expected_claim_expense: round2(expectedClaimExpense),
      csm_release_income: round2(csmReleaseIncome),
      csm_interest_expense: round2(csmInterestExpense),
      bel_locked_interest_expense: round2(belLockedInterestExpense),
      investment_return_income: round2(investmentReturnIncome),
      oci: round2(row.ifie_oci_discount_effect),
      net_income: round2(netIncome),
      total_comprehensive_income: round2(netIncome + row.ifie_oci_discount_effect),
    };
  });
}

function buildBS(rows) {
  let cumulativeCommission = 0;
  let cumulativeClaims = 0;
  let cumulativePremiums = 0;
  let cumulativeInvestmentReturn = 0;

  return rows.map((row) => {
    cumulativeCommission += Number(row.commission || 0);
    cumulativeClaims += Number(row.actual_claims || 0);
    cumulativePremiums += Number(row.actual_premiums || 0);
    cumulativeInvestmentReturn += Number(row.investment_return || 0);

    const commissionReceivable = round2(cumulativeCommission);
    const claimsRecoverable = round2(cumulativeClaims);
    const cededPremiumPayable = round2(cumulativePremiums);
    const reserveBelCurrent = round2(row.bel_current - row.exp_net_cf);
    const reserveCsm = round2(row.csm_closing);
    const financialAssets = round2(cumulativeInvestmentReturn);
    const bankDeposits = 0;

    const items = [
      commissionReceivable,
      claimsRecoverable,
      cededPremiumPayable,
      reserveBelCurrent,
      reserveCsm,
      financialAssets,
      bankDeposits,
    ];
    const assetTotal = round2(items.filter((value) => value > 0).reduce((acc, value) => acc + value, 0));
    const liabilityTotal = round2(items.filter((value) => value < 0).reduce((acc, value) => acc + Math.abs(value), 0));
    const netAssets = round2(assetTotal - liabilityTotal);

    return {
      date: row.date,
      month_index: row.month_index,
      reinsurance_contract_assets_commission: commissionReceivable,
      reinsurance_contract_assets_claims: claimsRecoverable,
      reinsurance_contract_assets_premiums_payable: cededPremiumPayable,
      reinsurance_contract_assets_bel_cr: reserveBelCurrent,
      reinsurance_contract_assets_csm: reserveCsm,
      financial_assets_investment_return: financialAssets,
      cash_in_bank: bankDeposits,
      total_assets: assetTotal,
      total_liabilities: liabilityTotal,
      net_assets: netAssets,
    };
  });
}

function getDisplayRows(rows) {
  return (rows || []).slice(1).map((row, index) => ({ ...row, display_month_index: index + 1 }));
}

function buildFlowReport(rows) {
  const displayRows = getDisplayRows(rows);
  if (!displayRows.length) return [];

  const m1 = { ...displayRows[0], report_period: "M1" };
  const baseRows = displayRows.slice(0, Math.min(60, displayRows.length));
  const years = [1, 2, 3, 4, 5]
    .map((year) => {
      const subset = baseRows.slice((year - 1) * 12, year * 12);
      if (!subset.length) return null;
      const keys = Object.keys(subset[0]).filter((key) => key !== "date");
      const aggregate = {};
      keys.forEach((key) => {
        if (key === "month_index" || key === "display_month_index") {
          aggregate[key] = subset[subset.length - 1][key];
        } else {
          aggregate[key] = round2(subset.reduce((acc, row) => acc + Number(row[key] || 0), 0));
        }
      });
      return { ...aggregate, report_period: `Y${year}` };
    })
    .filter(Boolean);

  return [m1, ...years].map((row) => ({ ...row, date: undefined, month_index: undefined, display_month_index: undefined }));
}

function buildStockReport(rows) {
  const displayRows = getDisplayRows(rows);
  if (!displayRows.length) return [];

  const m1 = { ...displayRows[0], report_period: "M1" };
  const baseRows = displayRows.slice(0, Math.min(60, displayRows.length));
  const years = [1, 2, 3, 4, 5]
    .map((year) => {
      const subset = baseRows.slice((year - 1) * 12, year * 12);
      if (!subset.length) return null;
      return { ...subset[subset.length - 1], report_period: `Y${year}` };
    })
    .filter(Boolean);

  return [m1, ...years].map((row) => ({ ...row, date: undefined, month_index: undefined, display_month_index: undefined }));
}

function parseDate(value) {
  if (value instanceof Date) return value;
  const text = String(value);
  if (/^\d{4}-\d{2}$/.test(text)) return new Date(`${text}-01T00:00:00`);
  return new Date(text);
}

function linearInterpolate(rows, col) {
  const values = rows.map((row) => (Number.isFinite(row[col]) ? row[col] : NaN));
  let firstValid = values.findIndex((value) => Number.isFinite(value));
  if (firstValid < 0) {
    rows.forEach((row) => {
      row[col] = 0;
    });
    return;
  }
  for (let i = 0; i < firstValid; i += 1) values[i] = values[firstValid];
  let last = firstValid;
  for (let i = firstValid + 1; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) continue;
    if (i - last > 1) {
      const step = (values[i] - values[last]) / (i - last);
      for (let j = last + 1; j < i; j += 1) values[j] = values[last] + step * (j - last);
    }
    last = i;
  }
  for (let i = last + 1; i < values.length; i += 1) values[i] = values[last];
  rows.forEach((row, index) => {
    row[col] = values[index];
  });
}

function num(value) {
  if (value === null || value === undefined || value === "") return 0;
  const normalized = String(value).replace(/,/g, "").trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}














