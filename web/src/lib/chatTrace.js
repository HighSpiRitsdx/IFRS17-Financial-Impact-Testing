const TRACE_DEFS = {
  csm_release_income: {
    label: 'CSM释放',
    aliases: ['csm释放', 'csm release', '释放'],
    report: 'PL',
  },
  csm_interest_expense: {
    label: 'CSM计息',
    aliases: ['csm计息', 'csm interest', '计息'],
    report: 'PL',
  },
  bel_locked_interest_expense: {
    label: 'BEL(锁定)计息',
    aliases: ['bel(锁定)计息', 'bel锁定计息', '锁定计息', 'bel @ lr 计息', 'bel计息'],
    report: 'PL',
  },
  oci: {
    label: 'OCI',
    aliases: ['oci', 'ifie oci'],
    report: 'PL',
  },
  net_income: {
    label: '净利润',
    aliases: ['净利润', '利润'],
    report: 'PL',
  },
  investment_return_income: {
    label: '投资收益',
    aliases: ['投资收益', '投资收入'],
    report: 'PL',
  },
  total_comprehensive_income: {
    label: '综合收益总额',
    aliases: ['综合收益总额', '综合收益'],
    report: 'PL',
  },
  net_assets: {
    label: '净资产',
    aliases: ['净资产', '净值'],
    report: 'BS',
  },
  reinsurance_contract_assets_bel_cr: {
    label: 'BEL(当期)',
    aliases: ['bel(当期)', 'bel当期', 'bel @ cr', 'bel@cr', '当期bel'],
    report: 'BS',
  },
  reinsurance_contract_assets_csm: {
    label: 'CSM期末余额',
    aliases: ['csm期末余额', 'csm余额', '期末csm', 'csm closing'],
    report: 'BS',
  },
};

export function buildChatTraceContext(question, scenario) {
  if (!question || !scenario?.results) return '';

  const candidates = buildCandidates(scenario.results);
  if (!candidates.length) return '';

  const periodHint = extractPeriodHint(question);
  const metricHint = extractMetricHint(question);
  const numericHints = extractNumericHints(question);

  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, { periodHint, metricHint, numericHints }),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.period.localeCompare(b.period));

  const topCandidates = scored.slice(0, 3);
  if (!topCandidates.length) {
    return [
      `当前活动情景：${scenario.name}`,
      '当前没有在已支持字段中定位到明确候选。',
      '当前优先支持字段：CSM释放、CSM计息、BEL(锁定)计息、OCI、净利润、净资产、BEL(当期)、BEL @ CR、投资收益、综合收益总额、CSM期末余额。',
    ].join('\n');
  }

  return [
    `当前活动情景：${scenario.name}`,
    `用户问题：${question}`,
    `识别结果：期间=${periodHint || '未明确'}；字段=${metricHint ? TRACE_DEFS[metricHint].label : '未明确'}；数字=${numericHints.length ? numericHints.join(' / ') : '未明确'}`,
    '以下是系统基于当前活动情景生成的数字追溯候选，请优先依据这些候选回答：',
    ...topCandidates.map((candidate, index) => formatCandidate(candidate, index + 1)),
  ].join('\n\n');
}

function buildCandidates(results) {
  const output = [];
  const plReport = results.plReport || [];
  const bsReport = results.bsReport || [];
  const plMonthly = getDisplayRows(results.plMonthly || []);
  const bsMonthly = getDisplayRows(results.bsMonthly || []);
  const nodeMonthly = getDisplayRows(results.nodeOutputs || []);

  Object.entries(TRACE_DEFS).forEach(([key, def]) => {
    if (def.report === 'PL') {
      plReport.forEach((row) => {
        if (isFiniteNumber(row[key])) {
          output.push(buildCandidate('PL', key, def, row.report_period, row[key], plMonthly, bsMonthly, nodeMonthly));
        }
      });
    }
    if (def.report === 'BS') {
      bsReport.forEach((row) => {
        if (isFiniteNumber(row[key])) {
          output.push(buildCandidate('BS', key, def, row.report_period, row[key], plMonthly, bsMonthly, nodeMonthly));
        }
      });
    }
  });

  return output;
}

function buildCandidate(section, key, def, period, value, plMonthly, bsMonthly, nodeMonthly) {
  const months = getMonthsForPeriod(period, nodeMonthly.length);
  const monthlyNodes = months.map((month) => nodeMonthly[month - 1]).filter(Boolean);
  const monthlyPl = months.map((month) => plMonthly[month - 1]).filter(Boolean);
  const monthlyBs = months.map((month) => bsMonthly[month - 1]).filter(Boolean);

  return {
    section,
    key,
    label: def.label,
    period,
    value: round2(value),
    months,
    explanation: explainCandidate(key, def.label, period, value, monthlyNodes, monthlyPl, monthlyBs),
  };
}

function explainCandidate(key, label, period, value, monthlyNodes, monthlyPl, monthlyBs) {
  const isAnnual = /^Y/i.test(period);
  const firstNode = monthlyNodes[0] || {};
  const firstPl = monthlyPl[0] || {};
  const firstBs = monthlyBs[0] || {};
  const lastBs = monthlyBs[monthlyBs.length - 1] || monthlyBs[0] || {};

  if (key === 'csm_release_income') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 口径为 ${monthsLabel(monthlyNodes)} 各月 CSM释放收入求和。` : `${period} 口径为单月值。`,
      '月度公式：CSM释放收入 = -csm_amortization。',
      `其中首月涉及：csm_opening=${formatNumber(firstNode.csm_opening)}，csm_interest=${formatNumber(firstNode.csm_interest)}，unlocking_to_csm=${formatNumber(firstNode.unlocking_to_csm)}，csm_pre_amort=${formatNumber(firstNode.csm_pre_amort)}，csm_amortization=${formatNumber(firstNode.csm_amortization)}。`,
    ].join(' ');
  }

  if (key === 'csm_interest_expense') {
    const rate = safeDivide(firstNode.csm_interest, firstNode.csm_opening);
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyNodes)} 各月 CSM计息求和。` : `${period} 为单月值。`,
      '月度公式：csm_interest = csm_opening × i_csm。',
      `其中首月涉及：csm_opening=${formatNumber(firstNode.csm_opening)}，有效月计息率约=${formatPercent(rate)}。`,
    ].join(' ');
  }

  if (key === 'bel_locked_interest_expense') {
    const prevDf = getPreviousDf(monthlyNodes, 0);
    const rate = firstNode.df && prevDf ? 1 - firstNode.df / prevDf : 0;
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyNodes)} 各月 BEL(锁定)计息求和。` : `${period} 为单月值。`,
      '月度公式：BEL(锁定)计息 = 当期 bel_locked × (1 - 当期df / 上期df)。',
      `其中首月涉及：bel_locked=${formatNumber(firstNode.bel_locked)}，当期df=${formatNumber(firstNode.df)}，上期df=${formatNumber(prevDf)}，计息率=${formatPercent(rate)}。`,
    ].join(' ');
  }

  if (key === 'oci') {
    const prevDelta = getPreviousDeltaBel(monthlyNodes, 0);
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyNodes)} 各月 OCI 求和。` : `${period} 为单月值。`,
      '月度公式：OCI = 当期 delta_bel - 上期 delta_bel（M0 直接取 delta_bel）。',
      `其中首月涉及：delta_bel=${formatNumber(firstNode.delta_bel)}，上期delta_bel=${formatNumber(prevDelta)}。`,
    ].join(' ');
  }

  if (key === 'net_income') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyPl)} 各月净利润求和。` : `${period} 为单月值。`,
      '月度公式：净利润 = 实际赔付收入 + 预期赔付支出 + CSM释放收入 + CSM计息支出 + BEL(锁定)计息支出 + 投资收益收入。',
      `其中首月涉及：实际赔付收入=${formatNumber(firstPl.actual_claim_income)}，预期赔付支出=${formatNumber(firstPl.expected_claim_expense)}，CSM释放收入=${formatNumber(firstPl.csm_release_income)}，CSM计息支出=${formatNumber(firstPl.csm_interest_expense)}，BEL(锁定)计息支出=${formatNumber(firstPl.bel_locked_interest_expense)}，投资收益收入=${formatNumber(firstPl.investment_return_income)}。`,
    ].join(' ');
  }

  if (key === 'investment_return_income') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyPl)} 各月投资收益收入求和。` : `${period} 为单月值。`,
      '月度公式：investment_return_income = investment_return。',
      `其中首月涉及：investment_base=${formatNumber(firstNode.investment_base)}，investment_return=${formatNumber(firstNode.investment_return)}。`,
    ].join(' ');
  }

  if (key === 'total_comprehensive_income') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 为 ${monthsLabel(monthlyPl)} 各月综合收益总额求和。` : `${period} 为单月值。`,
      '月度公式：综合收益总额 = net_income + oci。',
      `其中首月涉及：net_income=${formatNumber(firstPl.net_income)}，oci=${formatNumber(firstPl.oci)}。`,
    ].join(' ');
  }

  if (key === 'net_assets') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 在 BS 中取该年度年末余额。` : `${period} 在 BS 中取月末余额。`,
      '公式：净资产 = 资产汇总 - 负债汇总。',
      `其中当期涉及：资产汇总=${formatNumber(lastBs.total_assets)}，负债汇总=${formatNumber(lastBs.total_liabilities)}。`,
    ].join(' ');
  }

  if (key === 'reinsurance_contract_assets_bel_cr') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 在 BS 中取该年度年末余额。` : `${period} 为月末 BEL @ CR。`,
      '月度公式：BEL @ CR = bel_current - exp_net_cf。',
      `其中首月涉及：bel_current=${formatNumber(firstNode.bel_current)}，exp_net_cf=${formatNumber(firstNode.exp_net_cf)}，BEL @ CR=${formatNumber(firstBs.reinsurance_contract_assets_bel_cr)}。`,
    ].join(' ');
  }

  if (key === 'reinsurance_contract_assets_csm') {
    return [
      `${period} 的 ${label} = ${formatNumber(value)}。`,
      isAnnual ? `${period} 在 BS 中取该年度年末余额。` : `${period} 为月末 CSM 余额。`,
      '月度公式：CSM期末余额 = csm_closing。',
      `其中首月涉及：csm_opening=${formatNumber(firstNode.csm_opening)}，csm_interest=${formatNumber(firstNode.csm_interest)}，csm_amortization=${formatNumber(firstNode.csm_amortization)}，csm_closing=${formatNumber(firstNode.csm_closing)}。`,
    ].join(' ');
  }

  return `${period} 的 ${label} = ${formatNumber(value)}。`;
}

function scoreCandidate(candidate, hints) {
  let score = 0;
  if (hints.metricHint && candidate.key === hints.metricHint) score += 70;
  if (hints.periodHint && candidate.period.toUpperCase() === hints.periodHint.toUpperCase()) score += 60;

  if (hints.numericHints.length) {
    const closest = Math.min(...hints.numericHints.map((target) => Math.abs(candidate.value - target)));
    const tolerance = Math.max(0.5, Math.abs(candidate.value) * 0.000001);
    if (closest <= tolerance) score += 80;
    else if (closest <= tolerance * 5) score += 30;
  }

  if (!hints.metricHint && !hints.periodHint && !hints.numericHints.length) score += 1;
  if (candidate.section === 'PL' || candidate.section === 'BS') score += 5;
  return score;
}

function extractMetricHint(question) {
  const normalized = normalizeText(question);
  return Object.entries(TRACE_DEFS).find(([, def]) => def.aliases.some((alias) => normalized.includes(normalizeText(alias))))?.[0] || null;
}

function extractPeriodHint(question) {
  const match = String(question || '').match(/\b([MYmy]\d{1,3})\b/);
  return match ? match[1].toUpperCase() : null;
}

function extractNumericHints(question) {
  const matches = String(question || '').match(/(?<![A-Za-z])[-+]?\d[\d,]*(?:\.\d+)?/g) || [];
  return matches
    .map((text) => Number(String(text).replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
}

function getDisplayRows(rows) {
  return (rows || []).slice(1).map((row, index) => ({ ...row, display_month_index: index + 1 }));
}

function getMonthsForPeriod(period, maxMonths) {
  if (!period) return [];
  if (/^M\d+$/i.test(period)) {
    const month = Number(period.slice(1));
    return month >= 1 && month <= maxMonths ? [month] : [];
  }
  if (/^Y\d+$/i.test(period)) {
    const year = Number(period.slice(1));
    const start = (year - 1) * 12 + 1;
    const end = Math.min(year * 12, maxMonths);
    const months = [];
    for (let month = start; month <= end; month += 1) months.push(month);
    return months;
  }
  return [];
}

function monthsLabel(rows) {
  if (!rows?.length) return '无月度数据';
  const start = rows[0]?.display_month_index || 1;
  const end = rows[rows.length - 1]?.display_month_index || start;
  return start === end ? `M${start}` : `M${start}~M${end}`;
}

function getPreviousDf(rows, index) {
  if (!rows.length) return 0;
  const first = rows[index];
  const absoluteIndex = (first?.display_month_index || 1) - 1;
  if (absoluteIndex <= 0) return 1;
  return rows[index - 1]?.df ?? 1;
}

function getPreviousDeltaBel(rows, index) {
  if (!rows.length) return 0;
  const absoluteIndex = (rows[index]?.display_month_index || 1) - 1;
  if (absoluteIndex <= 0) return 0;
  return rows[index - 1]?.delta_bel ?? 0;
}

function formatCandidate(candidate, rank) {
  return [
    `${rank}. ${candidate.section} / ${candidate.period} / ${candidate.label} = ${formatNumber(candidate.value)}`,
    `   ${candidate.explanation}`,
  ].join('\n');
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[\s（）()_\-]/g, '');
}

function safeDivide(a, b) {
  const numerator = Number(a || 0);
  const denominator = Number(b || 0);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0.00%';
  return `${(value * 100).toFixed(4)}%`;
}

function formatNumber(value) {
  const numeric = Number(value || 0);
  return numeric.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
