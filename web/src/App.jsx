import { Component, memo, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import katex from "katex";
import "katex/dist/katex.min.css";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  FIELD_LABELS,
  GLOBAL_DEFAULTS,
  GLOBAL_VARIABLE_LABELS,
  HIDE_COLUMNS,
  NODE_DEFAULTS,
  NODE_EXAMPLE_CONFIGS,
  NODE_EXPLANATIONS,
  NODE_FORMULA_DETAILS,
  NODE_TITLES,
  NODE_TARGETS,
  NODE_VARIABLE_LABELS,
  PERCENT_KEYS,
  SCENARIO_KEY_LABELS,
} from "./lib/constants";
import { exportScenarioWorkbook } from "./lib/exporter";
import { findChangedVariables, runEngine } from "./lib/engine";
import { buildChatTraceContext } from "./lib/chatTrace";

const NAV_ITEMS = [
  { key: "final", label: "最终报表" },
  { key: "charts", label: "图表分析" },
  { key: "attribution", label: "利源归因" },
  ...Object.keys(NODE_DEFAULTS).map((n) => ({ key: n, label: NODE_TITLES[n] })),
];

const COLORS = ["#64748b", "#7c8aa5", "#8aa399", "#a18bbd", "#b7967d", "#6f8f98", "#b38a8a"];
const COMPARE_BAR_PALETTE = ["#6f86ad", "#b68b73", "#8a9f95", "#9b86b8"];
const COMPARE_LINE_PALETTE = ["#5f7598", "#9e765f", "#708a7f", "#866fa7"];

function buildScenarioCaption(scenarios) {
  if (!scenarios || !scenarios.length) return "暂无";
  if (scenarios.length === 1) return scenarios[0].name;
  return scenarios.map((scenario) => scenario.name).join(" vs ");
}


const PL_LAYOUT = [
  { category: "收入", item: "实际摊回死伤医疗给付的保险成分", key: "actual_claim_income" },
  { category: "收入", item: "CSM释放", key: "csm_release_income" },
  { category: "收入", item: "RA释放", constant: null },
  { category: "收入", item: "投资收益", key: "investment_return_income" },
  { category: "支出", item: "预期摊回死伤医疗给付的保险成分", key: "expected_claim_expense" },
  { category: "支出", item: "亏损加剧", constant: null },
  {
    category: "IFIE PL",
    item: "利息",
    compute: (row) => sumNumbers(row.csm_interest_expense, row.bel_locked_interest_expense),
  },
  { category: "IFIE PL", item: "其中 - CSM计息", key: "csm_interest_expense" },
  { category: "IFIE PL", item: "其中 - BEL @ LR 计息", key: "bel_locked_interest_expense" },
  { category: "利润", item: "利润", key: "net_income" },
  { category: "OCI", item: "IFIE OCI", key: "oci" },
  { category: "OCI", item: "综合收益总额", key: "total_comprehensive_income" },
];

const BS_LAYOUT = [
  { category: "资产", item: "再保险合同资产 - 应收分保佣金", key: "reinsurance_contract_assets_commission" },
  { category: "资产", item: "再保险合同资产 - 应收摊回赔款", key: "reinsurance_contract_assets_claims" },
  { category: "资产", item: "再保险合同资产 - 应付分出保费", key: "reinsurance_contract_assets_premiums_payable" },
  { category: "资产", item: "再保险合同资产 - 应收分保准备金 - BEL @ CR", key: "reinsurance_contract_assets_bel_cr" },
  { category: "资产", item: "再保险合同资产 - 应收分保准备金 - CSM", key: "reinsurance_contract_assets_csm" },
  { category: "资产", item: "金融资产（记录投资收益部分）", key: "financial_assets_investment_return" },
  { category: "资产", item: "银行存款", key: "cash_in_bank" },
  { category: "汇总", item: "资产汇总", key: "total_assets" },
  { category: "汇总", item: "负债汇总", key: "total_liabilities" },
  { category: "净资产", item: "净资产", key: "net_assets" },
];

class PanelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.panelKey !== this.props.panelKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-box">
          当前页面渲染失败：{this.state.error.message || String(this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}


export default function App() {
  const [activeTab, setActiveTab] = useState("final");
  const [rawRows, setRawRows] = useState([]);
  const [uploadName, setUploadName] = useState("");
  const [parseError, setParseError] = useState("");
  const [chartMaxMonths, setChartMaxMonths] = useState(60);
  const [chartMaxYears, setChartMaxYears] = useState(5);

  const [globalVars, setGlobalVars] = useState({ ...GLOBAL_DEFAULTS });
  const [nodeOverrides, setNodeOverrides] = useState(cloneNodeDefaults());
  const [nodeShadowMode, setNodeShadowMode] = useState(
    Object.fromEntries(Object.keys(NODE_DEFAULTS).map((key) => [key, true]))
  );
  const [globalAddScenario, setGlobalAddScenario] = useState(true);
  const [compareScenarioIds, setCompareScenarioIds] = useState([]);
  const [reportHighlight, setReportHighlight] = useState(null);
  const [attributionDraftVars, setAttributionDraftVars] = useState({ ...GLOBAL_DEFAULTS });
  const [attributionResults, setAttributionResults] = useState(null);
  const [attributionBaseResults, setAttributionBaseResults] = useState(null);

  const [scenarios, setScenarios] = useState([]);
  const [activeScenarioId, setActiveScenarioId] = useState("global-base");

  const previewState = useMemo(() => {
    if (!rawRows.length) return { results: null, error: "" };
    try {
      return { results: runEngine(rawRows, globalVars, nodeOverrides), error: "" };
    } catch (error) {
      return { results: null, error: error.message || "计算失败" };
    }
  }, [rawRows, globalVars, nodeOverrides]);

  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === activeScenarioId) || scenarios[0],
    [scenarios, activeScenarioId]
  );

  useEffect(() => {
    if (scenarios.length <= 2) {
      setCompareScenarioIds(scenarios.map((scenario) => scenario.id));
      return;
    }
    setCompareScenarioIds((prev) => {
      const valid = prev.filter((id) => scenarios.some((scenario) => scenario.id === id));
      if (valid.length >= 1) return valid.slice(0, 2);
      return scenarios.slice(-2).map((scenario) => scenario.id);
    });
  }, [scenarios]);

  useEffect(() => {
    if (activeTab !== "final" && reportHighlight) {
      setReportHighlight(null);
    }
  }, [activeTab, reportHighlight]);

  useEffect(() => {
    if (!rawRows.length) {
      setAttributionBaseResults(null);
      setAttributionResults(null);
      return;
    }
    try {
      const base = runEngine(rawRows, GLOBAL_DEFAULTS, nodeOverrides);
      setAttributionBaseResults(base);
      setAttributionResults((prev) => (activeTab === "attribution" && prev ? prev : base));
    } catch (error) {
      setAttributionBaseResults(null);
      setAttributionResults(null);
    }
  }, [rawRows, nodeOverrides, activeTab]);

  useEffect(() => {
    if (activeTab === "attribution") return;
    setAttributionDraftVars({ ...GLOBAL_DEFAULTS });
    setAttributionResults(attributionBaseResults);
  }, [activeTab, attributionBaseResults]);

  const panelError = parseError || previewState.error;

  function navigateToReport(target) {
    if (target?.scenarioId) setActiveScenarioId(target.scenarioId);
    setActiveTab("final");
    setReportHighlight({ ...(target || {}), token: Date.now() });
  }

  function updateAttributionDraftVar(key, value) {
    setAttributionDraftVars((prev) => ({ ...prev, [key]: value }));
  }

  function runAttributionTest() {
    if (!rawRows.length) {
      setParseError("请先上传 CSV");
      return;
    }
    try {
      const tested = runEngine(rawRows, attributionDraftVars, nodeOverrides);
      setAttributionResults(tested);
      setParseError("");
    } catch (error) {
      setParseError(error.message || "计算失败");
    }
  }

  function onUpload(file) {
    if (!file) return;
    setUploadName(file.name);
    setParseError("");

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        try {
          const rows = result.data || [];
          setRawRows(rows);
          rebuildGlobalScenario(rows, globalVars, nodeOverrides);
        } catch (error) {
          setParseError(error.message || "CSV 解析失败");
        }
      },
      error: (error) => setParseError(error.message || "CSV 解析失败"),
    });
  }

  function rebuildGlobalScenario(rows, nextGlobalVars, nextNodeOverrides) {
    const results = runEngine(rows, nextGlobalVars, nextNodeOverrides);
    const baseScenario = {
      id: "global-base",
      name: buildScenarioName(nextGlobalVars, nextNodeOverrides),
      sourceNode: "node0",
      results,
    };
    setScenarios((prev) => {
      const others = prev.filter((scenario) => scenario.id !== "global-base");
      return [baseScenario, ...others];
    });
    setActiveScenarioId("global-base");
  }

  function buildScenarioName(nextGlobalVars) {
    return `计息率${formatScenarioRate(nextGlobalVars.csmAccretionRateAnnual)}，释放率${formatScenarioRate(nextGlobalVars.csmAmortizationRateAnnual)}，收益率${formatScenarioRate(nextGlobalVars.investmentReturnRate)}`;
  }
  function runFromNode(nodeKey) {
    if (!rawRows.length) {
      setParseError("请先上传 CSV");
      return;
    }

    try {
      const results = runEngine(rawRows, globalVars, nodeOverrides);
      const name = buildScenarioName(globalVars, nodeOverrides);
      const shadow = nodeShadowMode[nodeKey];

      if (shadow) {
        const id = `${nodeKey}-${Date.now()}`;
        setScenarios((prev) => [...prev, { id, name, sourceNode: nodeKey, results }]);
        setActiveScenarioId(id);
      } else {
        setScenarios((prev) =>
          prev.map((scenario) =>
            scenario.id === activeScenarioId ? { ...scenario, name, sourceNode: nodeKey, results } : scenario
          )
        );
      }
      setParseError("");
    } catch (error) {
      setParseError(error.message || "计算失败");
    }
  }

  function calculateGlobalScenario() {
    if (!rawRows.length) {
      setParseError("请先上传 CSV");
      return;
    }
    try {
      const name = buildScenarioName(globalVars, nodeOverrides);
      if (globalAddScenario && name !== "默认参数") {
        const results = runEngine(rawRows, globalVars, nodeOverrides);
        const id = `global-${Date.now()}`;
        setScenarios((prev) => [...prev, { id, name, sourceNode: "node0", results }]);
        setActiveScenarioId(id);
      } else {
        rebuildGlobalScenario(rawRows, globalVars, nodeOverrides);
      }
      setParseError("");
    } catch (error) {
      setParseError(error.message || "计算失败");
    }
  }

  function updateGlobalVar(key, value) {
    setGlobalVars((prev) => ({ ...prev, [key]: value }));
  }

  function updateNodeVar(nodeKey, key, value) {
    setNodeOverrides((prev) => ({
      ...prev,
      [nodeKey]: { ...prev[nodeKey], [key]: value },
    }));
  }

  function resetAll() {
    const nextGlobalVars = { ...GLOBAL_DEFAULTS };
    const nextNodeOverrides = cloneNodeDefaults();
    setGlobalVars(nextGlobalVars);
    setNodeOverrides(nextNodeOverrides);
    setNodeShadowMode(Object.fromEntries(Object.keys(NODE_DEFAULTS).map((key) => [key, true])));
    if (rawRows.length) rebuildGlobalScenario(rawRows, nextGlobalVars, nextNodeOverrides);
  }

  function downloadExcel() {
    if (!scenarios.length) return;
    const blob = exportScenarioWorkbook(scenarios);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "ifrs17_scenarios.xlsx";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const isNode0 = activeTab === "node0";
  const activeNodeVars = isNode0 ? globalVars : nodeOverrides[activeTab];
  const activeVariableLabels = isNode0 ? GLOBAL_VARIABLE_LABELS : NODE_VARIABLE_LABELS;
  const activeUpdateVar = isNode0 ? updateGlobalVar : (key, value) => updateNodeVar(activeTab, key, value);

  return (
    <div className={`app-shell ${activeTab === "attribution" ? "no-right-sidebar" : ""}`.trim()}>
      <aside className="left-nav">
        <div className="brand">
          <img className="brand-logo" src="/logo.png" alt="IFRS17 财务影响测试平台 Logo" />
          <div className="brand-text">
            <div className="brand-title">IFRS17财务影响测试平台</div>
            <div className="brand-subtitle">开发者：KPMG 王涵</div>
          </div>
        </div>

        <div className="upload-box">
          <label className="upload-label">
            上传 CSV
            <input type="file" accept=".csv" onChange={(event) => onUpload(event.target.files?.[0])} />
          </label>
          <div className="upload-name">{uploadName || "未上传"}</div>
        </div>

        <nav>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${activeTab === item.key ? "active" : ""}`}
              onClick={() => setActiveTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-content">
        <ChatPanel activeTab={activeTab} activeScenario={activeScenario} />
        {panelError ? <div className="error-box">{panelError}</div> : null}

        {activeTab === "final" ? (
          <FinalReportPanel
            scenarios={scenarios}
            activeScenario={activeScenario}
            activeScenarioId={activeScenarioId}
            setActiveScenarioId={setActiveScenarioId}
            onExport={downloadExcel}
            highlightTarget={reportHighlight}
          />
        ) : null}

        {activeTab === "charts" ? (
          <ChartsPanel
            scenarios={scenarios}
            activeScenario={activeScenario}
            chartMaxMonths={chartMaxMonths}
            setChartMaxMonths={setChartMaxMonths}
            chartMaxYears={chartMaxYears}
            setChartMaxYears={setChartMaxYears}
            compareScenarioIds={compareScenarioIds}
            setCompareScenarioIds={setCompareScenarioIds}
            onNavigateToReport={navigateToReport}
          />
        ) : null}

        {activeTab === "attribution" ? (
          <AttributionPanel
            attributionResults={attributionResults}
            attributionBaseResults={attributionBaseResults}
            attributionDraftVars={attributionDraftVars}
            onChangeAttributionVar={updateAttributionDraftVar}
            onRunAttributionTest={runAttributionTest}
          />
        ) : null}

        {activeTab.startsWith("node") ? (
          <NodePanel
            nodeKey={activeTab}
            nodeVars={activeNodeVars}
            variableLabels={activeVariableLabels}
            shadow={nodeShadowMode[activeTab]}
            updateVar={activeUpdateVar}
            setShadow={(value) => setNodeShadowMode((prev) => ({ ...prev, [activeTab]: value }))}
            run={runFromNode}
            previewResults={previewState.results}
          />
        ) : null}
      </main>

      {activeTab !== "attribution" ? (
        <aside className="right-global">
          <h3>全局变量</h3>
          <VariableFields values={globalVars} labels={GLOBAL_VARIABLE_LABELS} onChange={updateGlobalVar} />
          <div className="actions compact-box global-action-row">
            <button className="reset-btn" onClick={calculateGlobalScenario}>
              计算
            </button>
            <label className="toggle-switch inline-switch">
              <input type="checkbox" checked={globalAddScenario} onChange={(event) => setGlobalAddScenario(event.target.checked)} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span>添加场景</span>
            </label>
          </div>
          <button className="secondary-btn" onClick={resetAll}>
            恢复默认参数
          </button>
        </aside>
      ) : null}
    </div>
  );
}

function FinalReportPanel({ scenarios, activeScenario, activeScenarioId, setActiveScenarioId, onExport, highlightTarget }) {
  const plRows = buildStatementRows(activeScenario?.results.plReport || [], PL_LAYOUT);
  const bsRows = buildStatementRows(activeScenario?.results.bsReport || [], BS_LAYOUT);
  const nodeRows = buildNodeDisplayRows(activeScenario?.results.nodeOutputs || []);

  useEffect(() => {
    if (!highlightTarget || !activeScenario) return;
    const ids = buildHighlightIds(highlightTarget, activeScenario.id || activeScenarioId);
    const firstExisting = ids.map((id) => document.getElementById(id)).find(Boolean);
    if (firstExisting) {
      firstExisting.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }
  }, [highlightTarget, activeScenario, activeScenarioId]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>最终报表</h2>
        <button onClick={onExport} disabled={!scenarios.length}>
          导出 Excel
        </button>
      </div>

      <div className="scenario-grid">
        {scenarios.map((scenario) => (
          <button
            key={scenario.id}
            className={`scenario-card ${activeScenarioId === scenario.id ? "active" : ""}`}
            onClick={() => setActiveScenarioId(scenario.id)}
          >
            <div className="scenario-name">{scenario.name}</div>
            <div className="scenario-meta">来源: {NODE_TITLES[scenario.sourceNode] || scenario.sourceNode}</div>
          </button>
        ))}
      </div>

      {activeScenario ? (
        <>
          <div className="summary-grid">
            <div className="summary-card">
              <div className="summary-label">BEL0</div>
              <div className="summary-value">{formatCell(activeScenario.results.summary.bel0, "BEL0")}</div>
              <div className="summary-note">M0 初始确认时点</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">CSM0</div>
              <div className="summary-value">{formatCell(-(activeScenario.results.summary.bel0 || 0), "CSM0")}</div>
              <div className="summary-note">按当前口径 CSM0 = -BEL0</div>
            </div>
          </div>

          <h3>利润表 (PL)</h3>
          <DataTable
            rows={plRows}
            hoverCrosshair
            getCellProps={(row, column) => getStatementCellProps("pl", activeScenarioId, row, column, highlightTarget)}
          />

          <h3>资产负债表 (BS)</h3>
          <DataTable
            rows={bsRows}
            hoverCrosshair
            getCellProps={(row, column) => getStatementCellProps("bs", activeScenarioId, row, column, highlightTarget)}
          />

          <details className="collapse" open={highlightTarget?.section === "node"}>
            <summary>Node 月度输出</summary>
            <DataTable
              rows={nodeRows}
              hideZeroColumns
              stickyFirstColumn
              getCellProps={(row, column) => getNodeCellProps(activeScenarioId, row, column, highlightTarget)}
            />
          </details>
        </>
      ) : (
        <div className="empty">请先上传 CSV 并运行计算。</div>
      )}
    </section>
  );
}
function ChartsPanel({
  scenarios,
  activeScenario,
  chartMaxMonths,
  setChartMaxMonths,
  chartMaxYears,
  setChartMaxYears,
  compareScenarioIds,
  setCompareScenarioIds,
  onNavigateToReport,
}) {
  const latestScenario = scenarios[scenarios.length - 1] || activeScenario || null;
  const maxAvailableMonths = useMemo(() => {
    if (!scenarios.length) return 1;
    return Math.max(1, ...scenarios.map((scenario) => Math.max(1, scenario.results.nodeOutputs.length - 1)));
  }, [scenarios]);
  const maxAvailableYears = useMemo(() => {
    if (!scenarios.length) return 1;
    return Math.min(
      100,
      Math.max(1, ...scenarios.map((scenario) => Math.max(1, Math.ceil((scenario.results.nodeOutputs.length - 1) / 12))))
    );
  }, [scenarios]);

  const normalizedMonths = clampValue(chartMaxMonths, 1, maxAvailableMonths);
  const normalizedYears = clampValue(chartMaxYears, 1, maxAvailableYears);
  const [monthDraft, setMonthDraft] = useState(String(normalizedMonths));
  const [yearDraft, setYearDraft] = useState(String(normalizedYears));

  useEffect(() => setMonthDraft(String(normalizedMonths)), [normalizedMonths]);
  useEffect(() => setYearDraft(String(normalizedYears)), [normalizedYears]);

  const compareScenarios = getCompareScenarios(scenarios, compareScenarioIds);
  const latestAnnual = useMemo(() => buildAnnualScenarioRows(latestScenario, normalizedYears), [latestScenario, normalizedYears]);
  const monthlyBelTrendData = useMemo(() => {
    const rows = getMonthlyDisplayRows(latestScenario?.results.nodeOutputs, normalizedMonths);
    return rows.map((row, index) => ({
      period: `M${index + 1}`,
      monthIndex: index + 1,
      bel_locked: row.bel_locked || 0,
      bel_current: row.bel_current || 0,
    }));
  }, [latestScenario, normalizedMonths]);

  const annualIncomeExpenseProfitData = latestAnnual.map((row) => ({
    period: row.period,
    annual_income_excluding_investment: sumNumbers(row.actual_claim_income, row.csm_release_income),
    annual_expense_only_claim_and_loss: Math.abs(sumNumbers(row.expected_claim_expense, row.loss_accretion || 0)),
    annual_profit: row.net_income || 0,
  }));

  const annualCsmTrendData = latestAnnual.map((row) => ({
    period: row.period,
    csm_balance: row.reinsurance_contract_assets_csm || 0,
  }));

  const annualProfitCompareData = buildScenarioYearDataset(compareScenarios, normalizedYears, (yearRow) => ({
    net_profit: yearRow.net_income || 0,
  }));
  const annualNetAssetsCompareData = buildScenarioYearDataset(compareScenarios, normalizedYears, (yearRow) => ({
    net_assets: yearRow.net_assets || 0,
  }));
  const annualInvestmentVsInterestData = buildScenarioYearDataset(compareScenarios, normalizedYears, (yearRow) => {
    const interest = Math.abs(sumNumbers(yearRow.csm_interest_expense, yearRow.bel_locked_interest_expense));
    const investmentReturn = yearRow.investment_return_income || 0;
    return {
      investment_return: investmentReturn,
      interest,
      spread: investmentReturn - interest,
    };
  });

  const annualIncomeAxis = getAxisSpecFromRows(annualIncomeExpenseProfitData, ["annual_income_excluding_investment", "annual_expense_only_claim_and_loss", "annual_profit"]);
  const csmAxis = getAxisSpecFromRows(annualCsmTrendData, ["csm_balance"]);
  const belAxis = getAxisSpecFromRows(monthlyBelTrendData, ["bel_locked", "bel_current"]);
  const profitAxis = getAxisSpecFromRows(annualProfitCompareData, collectMetricKeys(annualProfitCompareData));
  const netAssetsAxis = getAxisSpecFromRows(annualNetAssetsCompareData, collectMetricKeys(annualNetAssetsCompareData));
  const invInterestAxis = getAxisSpecFromRows(annualInvestmentVsInterestData, collectMetricKeys(annualInvestmentVsInterestData));
  const latestScenarioCaption = buildScenarioCaption(latestScenario ? [latestScenario] : []);
  const compareScenarioCaption = buildScenarioCaption(compareScenarios);


  const commitMonthDraft = () => setChartMaxMonths(clampValue(monthDraft, 1, maxAvailableMonths));
  const commitYearDraft = () => setChartMaxYears(clampValue(yearDraft, 1, maxAvailableYears));

  return (
    <section className="panel">
      <div className="panel-head chart-head">
        <h2>图表分析</h2>
        <div className="chart-controls-wrap">
          <div className="slider-box">
            <label>月度图最大期间</label>
            <div className="slider-inline">
              <input
                type="range"
                min="1"
                max={maxAvailableMonths}
                step="1"
                value={normalizedMonths}
                onChange={(event) => setChartMaxMonths(Number(event.target.value))}
              />
              <input
                type="number"
                min="1"
                max={maxAvailableMonths}
                value={monthDraft}
                onChange={(event) => setMonthDraft(event.target.value)}
                onBlur={commitMonthDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitMonthDraft();
                }}
              />
            </div>
          </div>
          <div className="slider-box">
            <label>年度图最大期间</label>
            <div className="slider-inline">
              <input
                type="range"
                min="1"
                max={maxAvailableYears}
                step="1"
                value={normalizedYears}
                onChange={(event) => setChartMaxYears(Number(event.target.value))}
              />
              <input
                type="number"
                min="1"
                max={maxAvailableYears}
                value={yearDraft}
                onChange={(event) => setYearDraft(event.target.value)}
                onBlur={commitYearDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitYearDraft();
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {scenarios.length > 2 ? (
        <details className="compare-picker">
          <summary>选择对比场景（最多 2 个）</summary>
          <div className="compare-options">
            {scenarios.map((scenario) => {
              const checked = compareScenarioIds.includes(scenario.id);
              const disabled = !checked && compareScenarioIds.length >= 2;
              return (
                <label key={scenario.id} className="compare-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleCompareScenario(scenario.id, compareScenarioIds, setCompareScenarioIds)}
                  />
                  <span>{scenario.name}</span>
                </label>
              );
            })}
          </div>
        </details>
      ) : null}

      <div className="chart-card figma-chart-card">
        <div className="chart-card-head">
          <h3>{`年度收入、支出与利润（${latestScenarioCaption}）`}</h3>
          <span className="chart-unit">{annualIncomeAxis.label}</span>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={annualIncomeExpenseProfitData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="period" />
            <YAxis yAxisId="left" tickFormatter={annualIncomeAxis.formatter} />
            <YAxis yAxisId="right" orientation="right" tickFormatter={annualIncomeAxis.formatter} />
            <Tooltip formatter={(value) => formatCell(value, "图表")} />
            <Legend />
            <Bar yAxisId="left" dataKey="annual_income_excluding_investment" barSize={40} fill="#7386a8" name="收入（不含投资收益）" onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: latestScenario?.id, period: data.period, rowKeys: ["actual_claim_income", "csm_release_income"] })} />
            <Bar yAxisId="left" dataKey="annual_expense_only_claim_and_loss" barSize={40} fill="#b89a76" name="支出" onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: latestScenario?.id, period: data.period, rowKeys: ["expected_claim_expense"] })} />
            <Line yAxisId="right" type="monotone" dataKey="annual_profit" stroke="#7b9b8d" strokeWidth={4} dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "pl", scenarioId: latestScenario?.id, period: payload.period, rowKeys: ["net_income"] }))} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "pl", scenarioId: latestScenario?.id, period: payload.period, rowKeys: ["net_income"] }), 6)} name="年度利润" onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: latestScenario?.id, period: data.period, rowKeys: ["net_income"] })} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-grid-2">
        <div className="chart-card figma-chart-card">
          <div className="chart-card-head">
            <h3>{`CSM 年度余额趋势（${latestScenarioCaption}）`}</h3>
            <span className="chart-unit">{csmAxis.label}</span>
          </div>
          <ResponsiveContainer width="100%" height={270}>
            <LineChart data={annualCsmTrendData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="period" />
              <YAxis tickFormatter={csmAxis.formatter} />
              <Tooltip formatter={(value) => formatCell(value, "图表")} />
              <Line type="monotone" dataKey="csm_balance" stroke="#8c80b5" strokeWidth={4} dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "bs", scenarioId: latestScenario?.id, period: payload.period, rowKeys: ["reinsurance_contract_assets_csm"] }))} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "bs", scenarioId: latestScenario?.id, period: payload.period, rowKeys: ["reinsurance_contract_assets_csm"] }), 6)} name="CSM余额" onClick={(data) => onNavigateToReport?.({ section: "bs", scenarioId: latestScenario?.id, period: data.period, rowKeys: ["reinsurance_contract_assets_csm"] })} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card figma-chart-card">
          <div className="chart-card-head">
            <h3>{`BEL(锁定) 与 BEL(当期) 月度趋势（${latestScenarioCaption}）`}</h3>
            <span className="chart-unit">{belAxis.label}</span>
          </div>
          <ResponsiveContainer width="100%" height={270}>
            <LineChart data={monthlyBelTrendData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="period" />
              <YAxis tickFormatter={belAxis.formatter} />
              <Tooltip formatter={(value) => formatCell(value, "图表")} />
              <Legend />
              <Line type="monotone" dataKey="bel_locked" stroke="#b78a6b" strokeWidth={4} dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: payload.monthIndex, fieldKeys: ["bel_locked"] }), 3.5)} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: payload.monthIndex, fieldKeys: ["bel_locked"] }), 6)} name="BEL(锁定)" onClick={(data) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: data.monthIndex, fieldKeys: ["bel_locked"] })} />
              <Line type="monotone" dataKey="bel_current" stroke="#7386a8" strokeWidth={4} dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: payload.monthIndex, fieldKeys: ["bel_current"] }), 3.5)} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: payload.monthIndex, fieldKeys: ["bel_current"] }), 6)} name="BEL(当期)" onClick={(data) => onNavigateToReport?.({ section: "node", scenarioId: latestScenario?.id, monthIndex: data.monthIndex, fieldKeys: ["bel_current"] })} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="chart-grid-2">
        <div className="chart-card figma-chart-card">
          <div className="chart-card-head">
            <h3>{`年度净利润对比（${compareScenarioCaption}）`}</h3>
            <span className="chart-unit">{profitAxis.label}</span>
          </div>
          <ResponsiveContainer width="100%" height={290}>
            <BarChart data={annualProfitCompareData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="period" />
              <YAxis tickFormatter={profitAxis.formatter} />
              <Tooltip formatter={(value) => formatCell(value, "图表")} />
              <Legend />
              {compareScenarios.map((scenario, index) => (
                <Bar key={scenario.id} dataKey={`${scenario.name}_net_profit`} fill={COMPARE_BAR_PALETTE[index % COMPARE_BAR_PALETTE.length]} name={`${scenario.name} 净利润`} onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: data.period, rowKeys: ["net_income"] })} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card figma-chart-card">
          <div className="chart-card-head">
            <h3>{`净资产年度趋势（${compareScenarioCaption}）`}</h3>
            <span className="chart-unit">{netAssetsAxis.label}</span>
          </div>
          <ResponsiveContainer width="100%" height={290}>
            <LineChart data={annualNetAssetsCompareData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="period" />
              <YAxis tickFormatter={netAssetsAxis.formatter} />
              <Tooltip formatter={(value) => formatCell(value, "图表")} />
              <Legend />
              {compareScenarios.map((scenario, index) => (
                <Line key={scenario.id} type="monotone" dataKey={`${scenario.name}_net_assets`} stroke={COLORS[index % COLORS.length]} strokeWidth={4} dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "bs", scenarioId: scenario.id, period: payload.period, rowKeys: ["net_assets"] }))} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "bs", scenarioId: scenario.id, period: payload.period, rowKeys: ["net_assets"] }), 6)} name={`${scenario.name} 净资产`} onClick={(data) => onNavigateToReport?.({ section: "bs", scenarioId: scenario.id, period: data.period, rowKeys: ["net_assets"] })} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="chart-card figma-chart-card">
        <div className="chart-card-head">
          <h3>{`年度投资收益与利息对比（${compareScenarioCaption}）`}</h3>
          <span className="chart-unit">{invInterestAxis.label}</span>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={annualInvestmentVsInterestData}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="period" />
            <YAxis yAxisId="left" tickFormatter={invInterestAxis.formatter} />
            <YAxis yAxisId="right" orientation="right" tickFormatter={invInterestAxis.formatter} />
            <Tooltip formatter={(value) => formatCell(value, "图表")} />
            <Legend />
            {compareScenarios.map((scenario, index) => (
              <Bar key={`${scenario.id}-investment`} yAxisId="left" dataKey={`${scenario.name}_investment_return`} fill={COMPARE_BAR_PALETTE[(index * 2) % COMPARE_BAR_PALETTE.length]} name={`${scenario.name} 投资收益`} onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: data.period, rowKeys: ["investment_return_income"] })} />
            ))}
            {compareScenarios.map((scenario, index) => (
              <Bar key={`${scenario.id}-interest`} yAxisId="left" dataKey={`${scenario.name}_interest`} fill={COMPARE_BAR_PALETTE[(index * 2 + 1) % COMPARE_BAR_PALETTE.length]} name={`${scenario.name} 利息`} onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: data.period, rowKeys: ["csm_interest_expense", "bel_locked_interest_expense"] })} />
            ))}
            {compareScenarios.map((scenario, index) => (
              <Line key={`${scenario.id}-spread`} yAxisId="right" type="monotone" dataKey={`${scenario.name}_spread`} stroke={COMPARE_LINE_PALETTE[index % COMPARE_LINE_PALETTE.length]} strokeWidth={4} strokeDasharray="5 5" dot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: payload.period, rowKeys: ["investment_return_income", "csm_interest_expense", "bel_locked_interest_expense"] }))} activeDot={clickableDotFactory((payload) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: payload.period, rowKeys: ["investment_return_income", "csm_interest_expense", "bel_locked_interest_expense"] }), 6)} name={`${scenario.name} 差额`} onClick={(data) => onNavigateToReport?.({ section: "pl", scenarioId: scenario.id, period: data.period, rowKeys: ["investment_return_income", "csm_interest_expense", "bel_locked_interest_expense"] })} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
function AttributionPanel({ attributionResults, attributionBaseResults, attributionDraftVars, onChangeAttributionVar, onRunAttributionTest }) {
  const annualRows = useMemo(() => buildAnnualResultRows(attributionResults, 100), [attributionResults]);
  const annualBaseRows = useMemo(() => buildAnnualResultRows(attributionBaseResults, 100), [attributionBaseResults]);
  const [selectedPeriod, setSelectedPeriod] = useState("Y1");
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  useEffect(() => {
    const firstPeriod = annualBaseRows[0]?.period || annualRows[0]?.period || "Y1";
    setSelectedPeriod(firstPeriod);
    setExpandedIds(new Set());
  }, [attributionResults, attributionBaseResults, annualRows.length, annualBaseRows.length]);

  const selectedRow = annualRows.find((row) => row.period === selectedPeriod) || annualRows[0] || null;
  const baseRow = annualBaseRows.find((row) => row.period === selectedPeriod) || annualBaseRows[0] || null;
  const tree = useMemo(() => buildAttributionTree(selectedRow, baseRow), [selectedRow, baseRow]);
  const { nodes, links, width, height } = useMemo(() => layoutAttributionTree(tree, expandedIds), [tree, expandedIds]);
  const csmMovement = useMemo(() => buildCsmMovementData(baseRow), [baseRow]);
  const csmMovementAxisMax = useMemo(() => getCsmMovementAxisMax(annualBaseRows), [annualBaseRows]);

  return (
    <section className="panel attribution-page">
      <div className="panel-head">
        <h2>利源归因</h2>
        <div className="attribution-toolbar">
          <select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>
            {(annualBaseRows.length ? annualBaseRows : annualRows).map((row) => (
              <option key={row.period} value={row.period}>
                {row.period}
              </option>
            ))}
          </select>
          <button onClick={() => setExpandedIds(new Set(getAllExpandableNodeIds(tree)))}>一键展开</button>
          <button className="secondary-btn" onClick={() => setExpandedIds(new Set())}>一键关闭</button>
        </div>
      </div>

      {selectedRow && baseRow ? (
        <div className="attribution-layout">
          <div>
            <div className="attribution-shell">
              <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="attribution-svg">
                {links.map((link) => (
                  <path
                    key={link.id}
                    d={`M ${link.x1} ${link.y1} C ${link.cx1} ${link.y1}, ${link.cx2} ${link.y2}, ${link.x2} ${link.y2}`}
                    stroke={link.color}
                    strokeWidth={link.strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    opacity="0.75"
                  />
                ))}
                {nodes.map((node) => {
                  const expandable = (node.children || []).length > 0;
                  const expanded = expandedIds.has(node.id);
                  return (
                    <g key={node.id} transform={`translate(${node.x}, ${node.y})`} className="tree-node-group">
                      <circle
                        r={expandable ? 10 : 8}
                        fill="#ffffff"
                        stroke={node.color}
                        strokeWidth="3"
                        className={expandable ? "tree-node clickable" : "tree-node"}
                        onClick={() => {
                          if (!expandable) return;
                          setExpandedIds((prev) => toggleNodeSet(prev, node.id));
                        }}
                      />
                      {expandable ? (
                        <text textAnchor="middle" dominantBaseline="middle" className="tree-node-toggle" onClick={() => setExpandedIds((prev) => toggleNodeSet(prev, node.id))}>
                          {expanded ? "−" : "+"}
                        </text>
                      ) : null}
                      <text x={14} y={-12} className="tree-node-label">{node.label}</text>
                      <text x={14} y={6} className="tree-node-value">{formatCell(node.value, node.label)}</text>
                      <text x={14} y={22} className={`tree-node-delta ${node.delta > 0 ? "up" : node.delta < 0 ? "down" : "flat"}`}>
                        {formatDelta(node.delta)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="chart-card figma-chart-card attribution-movement-card">
              <div className="chart-card-head">
                <h3>CSM Movement</h3>
                <span className="chart-unit">{csmMovement.axisLabel}</span>
              </div>
              <WaterfallChart data={csmMovement.rows} axisMax={csmMovementAxisMax} />
            </div>
          </div>

          <AttributionControlPanel values={attributionDraftVars} onChange={onChangeAttributionVar} onRun={onRunAttributionTest} />
        </div>
      ) : (
        <div className="empty">请先上传 CSV 并生成年度结果。</div>
      )}
    </section>
  );
}

function AttributionControlPanel({ values, onChange, onRun }) {
  return (
    <div className="attribution-side-panel">
      <h3>利源归因测试</h3>
      <p className="muted">仅影响当前页面上方树状图，不影响下方 CSM Movement，也不会写回其他页面。</p>
      {Object.entries(GLOBAL_VARIABLE_LABELS).map(([key, label]) => {
        const raw = Number(values[key] ?? 0) * 100;
        return (
          <div key={key} className="slider-field">
            <div className="slider-field-head">
              <span>{label}</span>
              <strong>{formatInputNumber(raw, 2)}%</strong>
            </div>
            <input type="range" min="0" max="10" step="0.1" value={raw} onChange={(event) => onChange(key, Number(event.target.value) / 100)} />
          </div>
        );
      })}
      <button className="reset-btn" onClick={onRun}>测试</button>
    </div>
  );
}
function NodePanel({ nodeKey, nodeVars, variableLabels, shadow, updateVar, setShadow, run, previewResults }) {
  const exampleRows = buildNodeExampleRows(nodeKey, previewResults);
  const node5InterestRows = nodeKey === "node5" ? buildNode5InterestRows(previewResults) : [];
  const formulaDetails = NODE_FORMULA_DETAILS[nodeKey] || [];

  return (
    <section className="panel">
      <h2>{NODE_TITLES[nodeKey]}</h2>
      <p className="muted">{NODE_EXPLANATIONS[nodeKey]}</p>

      <div className="node-top-grid">
        <div className="logic-box">
          <h3>计算过程与解释</h3>
          <div className="target-box">
            <div className="target-title">计算目标元素</div>
            <div className="target-text">{NODE_TARGETS[nodeKey]}</div>
          </div>
          <p>{nodeLogicText(nodeKey)}</p>

          <div className="formula-list">
            {formulaDetails.map((formula, index) => (
              <div key={`${nodeKey}-${index}`} className="formula-item">
                <div className="formula-title">公式 {index + 1}</div>
                <FormulaBlock latex={formula.latex} />
                <div className="formula-note">{formula.explanation}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="control-box">
          <div className="var-box compact-box">
            <h3>本节点变量</h3>
            <VariableFields values={nodeVars} labels={variableLabels} onChange={updateVar} />
          </div>

          <div className="actions compact-box">
            <label className="switch-row">
              <input type="checkbox" checked={shadow} onChange={(event) => setShadow(event.target.checked)} />
              <span>添加场景</span>
            </label>
            <button onClick={() => run(nodeKey)}>计算并保存场景</button>
          </div>
        </div>
      </div>

      <div className="example-box">
        <h3>计算示例（前10行）</h3>
        <DataTable rows={exampleRows} hideZeroColumns stickyFirstColumn />
      </div>

      {nodeKey === "node5" ? (
        <div className="example-box">
          <h3>锁定计息展开（前10行）</h3>
          <DataTable rows={node5InterestRows} hideZeroColumns stickyFirstColumn />
        </div>
      ) : null}
    </section>
  );
}

function VariableFields({ values, labels, onChange }) {
  return Object.keys(values || {}).map((key) => {
    const rawValue = Number(values[key] ?? 0);
    const isPercent = PERCENT_KEYS.includes(key);
    const displayValue = isPercent ? rawValue * 100 : rawValue;
    const normalizedDisplay = Number.isFinite(displayValue)
      ? formatInputNumber(displayValue, isPercent ? 2 : 4)
      : "0";

    return (
      <label key={key} className="field-row">
        <span>{labels[key] || key}</span>
        <div className={`value-input ${isPercent ? "percent" : ""}`}>
          <input
            type="number"
            step={isPercent ? "0.01" : "0.0001"}
            value={normalizedDisplay}
            onChange={(event) => onChange(key, parseInputValue(key, event.target.value))}
          />
          {isPercent ? <em>%</em> : null}
        </div>
      </label>
    );
  });
}

function DataTable({ rows, hideZeroColumns = false, getCellProps, stickyFirstColumn = false, hoverCrosshair = false }) {
  const wrapRef = useRef(null);
  const topBarRef = useRef(null);
  const topInnerRef = useRef(null);
  const [hovered, setHovered] = useState({ row: -1, col: -1 });

  const visibleColumns = useMemo(() => {
    if (!rows?.length) return [];
    const columns = Object.keys(rows[0]).filter((column) => !String(column).startsWith("__"));
    if (!hideZeroColumns) return columns;

    return columns.filter((column) => {
      const values = rows.map((row) => row[column]);
      const numericValues = values.filter((value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)));
      if (!numericValues.length) return true;
      return numericValues.some((value) => Math.abs(Number(value)) > 1e-12);
    });
  }, [rows, hideZeroColumns]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const top = topBarRef.current;
    const inner = topInnerRef.current;
    if (!wrap || !top || !inner) return undefined;

    const syncWidths = () => {
      inner.style.width = `${wrap.scrollWidth}px`;
      top.style.display = wrap.scrollWidth > wrap.clientWidth ? "block" : "none";
    };

    const onWrapScroll = () => {
      if (top.scrollLeft !== wrap.scrollLeft) top.scrollLeft = wrap.scrollLeft;
    };
    const onTopScroll = () => {
      if (wrap.scrollLeft !== top.scrollLeft) wrap.scrollLeft = top.scrollLeft;
    };

    syncWidths();
    const resizeObserver = new ResizeObserver(syncWidths);
    resizeObserver.observe(wrap);
    wrap.addEventListener("scroll", onWrapScroll);
    top.addEventListener("scroll", onTopScroll);
    window.addEventListener("resize", syncWidths);

    return () => {
      resizeObserver.disconnect();
      wrap.removeEventListener("scroll", onWrapScroll);
      top.removeEventListener("scroll", onTopScroll);
      window.removeEventListener("resize", syncWidths);
    };
  }, [rows, visibleColumns]);

  if (!rows?.length || !visibleColumns.length) return <div className="empty">暂无数据</div>;

  return (
    <div className="table-shell">
      <div className="table-scroll-top" ref={topBarRef}>
        <div className="table-scroll-inner" ref={topInnerRef} />
      </div>
      <div className={`table-wrap ${stickyFirstColumn ? "sticky-wrap" : ""}`} ref={wrapRef}>
        <table className={`${stickyFirstColumn ? "sticky-first-col" : ""} ${hoverCrosshair ? "hover-crosshair" : ""}`.trim()}>
          <thead>
            <tr>
              {visibleColumns.map((column) => (
                <th key={column} className={`${isNumericColumn(rows, column) ? "num" : "text"} ${hoverCrosshair && hovered.col === visibleColumns.indexOf(column) ? "hover-col" : ""}`.trim()}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {visibleColumns.map((column, colIndex) => {
                  const extra = getCellProps ? getCellProps(row, column) || {} : {};
                  const className = `${isNumericValue(row[column]) ? "num" : "text"} ${extra.className || ""} ${hoverCrosshair && hovered.row === index ? "hover-row" : ""} ${hoverCrosshair && hovered.col === colIndex ? "hover-col" : ""}`.trim();
                  return (
                    <td
                      key={column}
                      id={extra.id}
                      className={className}
                      onMouseEnter={() => hoverCrosshair && setHovered({ row: index, col: colIndex })}
                      onMouseLeave={() => hoverCrosshair && setHovered({ row: -1, col: -1 })}
                    >
                      {formatCell(row[column], column)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function translateRows(rows, options = {}) {
  const { includeDate = false } = options;
  return (rows || []).map((row) => {
    const out = {};
    Object.entries(row).forEach(([key, value]) => {
      if (!includeDate && HIDE_COLUMNS.includes(key)) return;
      if (includeDate && key === "month_index") return;
      out[FIELD_LABELS[key] || key] = value;
    });
    return out;
  });
}

function buildStatementRows(reportRows, layout) {
  if (!reportRows?.length) return [];
  const periods = reportRows.map((row) => row.report_period);
  let lastCategory = null;

  return layout.map((definition) => {
    const out = {
      __rowKey: definition.key || definition.item,
      类别: definition.category === lastCategory ? "" : definition.category,
      项目: definition.item,
    };
    lastCategory = definition.category;

    periods.forEach((period) => {
      const source = reportRows.find((row) => row.report_period === period) || {};
      let value = null;
      if (definition.key) value = source[definition.key];
      if (definition.compute) value = definition.compute(source);
      if (Object.prototype.hasOwnProperty.call(definition, "constant")) value = definition.constant;
      out[period] = value;
    });

    return out;
  });
}

function buildNodeExampleRows(nodeKey, results) {
  if (!results?.nodeTables?.[nodeKey]?.length) return [];

  if (nodeKey === "node0") {
    return results.nodeTables.node0.slice(0, 10).map((row) => ({
      日期: row.date,
      "折现因子(df)": row.df,
      计算公式: "读取 Node 0 单条 df 曲线与全局比例参数",
      输出: "广播成功",
    }));
  }

  const config = NODE_EXAMPLE_CONFIGS[nodeKey];
  if (!config) return [];

  return results.nodeTables[nodeKey].slice(1, 11).map((row) => {
    const out = { 日期: row.date };
    config.inputColumns.forEach((column) => {
      out[FIELD_LABELS[column] || column] = row[column];
    });
    out[FIELD_LABELS.formula_text] = config.formulaLabel;
    config.outputColumns.forEach((column) => {
      out[FIELD_LABELS[column] || column] = row[column];
    });
    return out;
  });
}

function buildNodeDisplayRows(rows) {
  return (rows || []).slice(1).map((row, index) => {
    const out = { __monthIndex: index + 1, __fieldKeys: {}, 日期: row.date };
    Object.entries(row).forEach(([key, value]) => {
      if (key === "date" || key === "month_index") return;
      const label = FIELD_LABELS[key] || key;
      out[label] = value;
      out.__fieldKeys[label] = key;
    });
    return out;
  });
}

function buildHighlightIds(target, scenarioId) {
  if (!target) return [];
  if (target.section === "node") {
    return (target.fieldKeys || []).map((fieldKey) => `node-${scenarioId}-m${target.monthIndex}-${fieldKey}`);
  }
  return (target.rowKeys || []).map((rowKey) => `${target.section}-${scenarioId}-${rowKey}-${target.period}`);
}

function getStatementCellProps(section, scenarioId, row, column, highlightTarget) {
  if (!/^M\d+$|^Y\d+$/.test(String(column))) {
    return {};
  }
  const id = `${section}-${scenarioId}-${row.__rowKey}-${column}`;
  const isHighlighted =
    highlightTarget?.section === section &&
    highlightTarget?.scenarioId === scenarioId &&
    highlightTarget?.period === column &&
    (highlightTarget?.rowKeys || []).includes(row.__rowKey);
  return { id, className: isHighlighted ? "cell-highlight" : "" };
}

function getNodeCellProps(scenarioId, row, column, highlightTarget) {
  const fieldKey = row.__fieldKeys?.[column];
  if (!fieldKey) return {};
  const id = `node-${scenarioId}-m${row.__monthIndex}-${fieldKey}`;
  const isHighlighted =
    highlightTarget?.section === "node" &&
    highlightTarget?.scenarioId === scenarioId &&
    highlightTarget?.monthIndex === row.__monthIndex &&
    (highlightTarget?.fieldKeys || []).includes(fieldKey);
  return { id, className: isHighlighted ? "cell-highlight" : "" };
}
function buildNode5InterestRows(results) {
  const rows = results?.nodeTables?.node5;
  if (!rows?.length) return [];

  return rows.slice(1, 11).map((row, index) => {
    const previous = rows[index] ?? null;
    const priorDf = previous?.df ?? null;
    const currentDf = row.df;
    const rate = priorDf && currentDf ? 1 - currentDf / priorDf : 0;

    return {
      日期: row.date,
      "当期BEL(锁定)": row.bel_locked,
      "上期df": priorDf,
      "当期df": currentDf,
      计息率: rate,
      计算公式: "当期BEL_locked × (1 - 当期df / 上期df)",
      "BEL锁定计息": row.ifie_pnl_locked_interest,
      "累计OCI": row.delta_bel,
      "OCI当期变动": row.ifie_oci_discount_effect,
    };
  });
}

function nodeLogicText(nodeKey) {
  const map = {
    node0: "Node 0 不直接计算结果，负责维护单条 df 曲线、CSM 计息率、CSM 释放率和投资收益率。",
    node1: "本节点把原始保费、赔付、费用和佣金整理为预期/实际净现金流，并同步拆出 premium / claim / expense 偏差。",
    node2: "本节点对未来预期现金流分别计算 BEL_current 与 BEL_locked，差别只在于对同一条 df 曲线的调用方式。",
    node3: "本节点滚动 RA 期初、期末与利息增生，当前 Demo 默认 RA 为 0。",
    node4: "本节点在 M0 完成 CSM0 建账，并把初始结果传给后续经营月。",
    node5: "本节点把时间价值影响拆成两部分：BEL(锁定)计息进 P&L，Current/Locked 差异的期间变动进 OCI。",
    node6: "本节点把 premium 偏差送入 CSM 解锁，claim/expense 偏差保留为经验分析。",
    node7: "本节点完成 CSM roll-forward、投资收益滚动，并按利润表/资产负债表口径输出结果。",
  };
  return map[nodeKey] || "";
}

function FormulaBlock({ latex }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        throwOnError: false,
        displayMode: true,
        strict: 'ignore',
      });
    } catch (error) {
      return `<code>${latex}</code>`;
    }
  }, [latex]);

  return <div className="latex-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

function buildAnnualScenarioRows(scenario, maxYears) {
  if (!scenario?.results) return [];
  const plRows = getMonthlyDisplayRows(scenario.results.plMonthly || [], maxYears * 12);
  const bsRows = getMonthlyDisplayRows(scenario.results.bsMonthly || [], maxYears * 12);
  const years = [];
  for (let year = 1; year <= maxYears; year += 1) {
    const plSlice = plRows.slice((year - 1) * 12, year * 12);
    const bsSlice = bsRows.slice((year - 1) * 12, year * 12);
    if (!plSlice.length && !bsSlice.length) break;
    const row = { period: `Y${year}` };
    const samplePl = plSlice[0] || {};
    Object.keys(samplePl)
      .filter((key) => key !== "date" && key !== "month_index")
      .forEach((key) => {
        row[key] = round2(plSlice.reduce((acc, item) => acc + Number(item?.[key] || 0), 0));
      });
    const sampleBs = bsSlice[bsSlice.length - 1] || {};
    Object.keys(sampleBs)
      .filter((key) => key !== "date" && key !== "month_index")
      .forEach((key) => {
        row[key] = sampleBs[key];
      });
    years.push(row);
  }
  return years;
}

function getMonthlyDisplayRows(rows, maxMonths) {
  return (rows || []).slice(1, maxMonths + 1);
}

function buildScenarioYearDataset(scenarios, maxYears, projector) {
  const annualByScenario = scenarios.map((scenario) => ({
    scenario,
    rows: buildAnnualScenarioRows(scenario, maxYears),
  }));
  const periods = Array.from({ length: maxYears }, (_, index) => `Y${index + 1}`);
  return periods.map((period) => {
    const out = { period };
    annualByScenario.forEach(({ scenario, rows }) => {
      const yearRow = rows.find((row) => row.period === period) || {};
      const projection = projector(yearRow, scenario) || {};
      Object.entries(projection).forEach(([key, value]) => {
        out[`${scenario.name}_${key}`] = value;
      });
    });
    return out;
  });
}

function getCompareScenarios(scenarios, compareScenarioIds) {
  if (scenarios.length <= 2) return scenarios;
  const filtered = scenarios.filter((scenario) => compareScenarioIds.includes(scenario.id));
  return filtered.length ? filtered.slice(0, 2) : scenarios.slice(-2);
}

function toggleNodeSet(prev, nodeId) {
  const next = new Set(prev);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  return next;
}

function formatDelta(value) {
  const numeric = Number(value || 0);
  if (Math.abs(numeric) < 1e-9) return '0.00';
  const arrow = numeric > 0 ? '↑' : '↓';
  return `${arrow} ${formatCell(Math.abs(numeric), 'delta')}`;
}

function buildCsmMovementData(row) {
  const opening = Number(row?.csm_opening_display || 0);
  const nb = Number(row?.new_business_display || 0);
  const interest = Number(row?.csm_interest_movement || 0);
  const fcfChange = Number(row?.fcf_change_movement || 0);
  const fxChange = Number(row?.fx_change_movement || 0);
  const release = Number(row?.csm_release_movement || 0);
  const closing = Number(row?.csm_closing_display || 0);
  const rows = [
    { label: 'CSM Opening', value: opening, type: 'total' },
    { label: 'New Business', value: nb, type: 'movement' },
    { label: 'Interest Accretion', value: interest, type: 'movement' },
    { label: 'FCF Change', value: fcfChange, type: 'movement' },
    { label: 'FX Change', value: fxChange, type: 'movement' },
    { label: 'CSM Release', value: release, type: 'movement' },
    { label: 'CSM Closing', value: closing, type: 'total' },
  ];
  const maxAbs = Math.max(...rows.map((item) => Math.abs(item.value)), 1);
  const axisLabel = maxAbs >= 1000000 ? '单位：百万元' : '单位：元';
  return { rows, axisLabel };
}

function WaterfallChart({ data, axisMax }) {
  const width = 940;
  const height = 320;
  const left = 70;
  const right = 30;
  const top = 26;
  const bottom = 48;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maxAbs = Math.max(axisMax || 0, ...data.map((item) => Math.abs(item.value)), 1);
  const scale = chartHeight / (maxAbs * 1.15 || 1);
  const barWidth = chartWidth / Math.max(data.length, 1) - 12;
  let running = 0;
  const points = data.map((item, index) => {
    let start = running;
    let end = running;
    if (item.type === 'total') {
      start = 0;
      end = item.value;
      running = item.value;
    } else {
      end = running + item.value;
      running = end;
    }
    const x = left + index * (barWidth + 12);
    const y1 = top + chartHeight - start * scale;
    const y2 = top + chartHeight - end * scale;
    const y = Math.min(y1, y2);
    const h = Math.max(Math.abs(y2 - y1), 3);
    return { ...item, x, y, h, end };
  });
  const ticks = Array.from({ length: 6 }, (_, i) => (maxAbs * 1.1 * i) / 5);
  return (
    <div className="waterfall-wrap">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} className="waterfall-svg">
        {ticks.map((tick) => {
          const y = top + chartHeight - tick * scale;
          return (
            <g key={tick}>
              <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e2e8f0" />
              <text x={left - 10} y={y + 4} textAnchor="end" className="waterfall-axis-label">{formatShortValue(tick)}</text>
            </g>
          );
        })}
        {points.map((item) => (
          <g key={item.label}>
            <title>{`${item.label}: ${formatCell(item.value, item.label)}`}</title>
            <rect x={item.x} y={item.y} width={barWidth} height={item.h} rx="2" fill="#9b8abc" opacity={item.type === 'total' ? 1 : 0.9} />
            <text x={item.x + barWidth / 2} y={item.value >= 0 ? item.y - 8 : item.y + item.h + 14} textAnchor="middle" className="waterfall-value">{formatShortValue(item.value)}</text>
            <text x={item.x + barWidth / 2} y={height - 18} textAnchor="middle" className="waterfall-label">{item.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function getCsmMovementAxisMax(annualRows) {
  return Math.max(
    1,
    ...(annualRows || []).flatMap((row) => [
      Math.abs(Number(row?.csm_opening_display || 0)),
      Math.abs(Number(row?.new_business_display || 0)),
      Math.abs(Number(row?.csm_interest_movement || 0)),
      Math.abs(Number(row?.fcf_change_movement || 0)),
      Math.abs(Number(row?.fx_change_movement || 0)),
      Math.abs(Number(row?.csm_release_movement || 0)),
      Math.abs(Number(row?.csm_closing_display || 0)),
    ])
  );
}
function formatShortValue(value) {
  const abs = Math.abs(Number(value || 0));
  if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
  if (abs >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return Number(value || 0).toFixed(0);
}
function toggleCompareScenario(id, selectedIds, setSelectedIds) {
  if (selectedIds.includes(id)) {
    setSelectedIds(selectedIds.filter((item) => item !== id));
    return;
  }
  if (selectedIds.length >= 2) return;
  setSelectedIds([...selectedIds, id]);
}

function collectMetricKeys(rows) {
  return Array.from(
    new Set(
      (rows || []).flatMap((row) =>
        Object.keys(row || {}).filter((key) => key !== 'period' && key !== 'm')
      )
    )
  );
}

function getAxisSpecFromRows(rows, keys) {
  const values = (rows || []).flatMap((row) => (keys || []).map((key) => Number(row?.[key] || 0)));
  const maxAbs = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const useMillion = maxAbs >= 1000000;
  const divisor = useMillion ? 1000000 : 1;
  return {
    label: useMillion ? '单位：百万元' : '单位：元',
    formatter: (value) => formatAxisValue(value, divisor),
  };
}

function formatAxisValue(value, divisor) {
  const numeric = Number(value || 0) / divisor;
  if (!Number.isFinite(numeric)) return '-';
  if (Math.abs(numeric) >= 100) return numeric.toFixed(0);
  if (Math.abs(numeric) >= 10) return numeric.toFixed(1);
  return numeric.toFixed(2);
}

function formatInputNumber(value, decimals) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return numeric.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function clampValue(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(numeric, min), max);
}
function buildAnnualResultRows(results, maxYears) {
  if (!results) return [];
  const plRows = getMonthlyDisplayRows(results.plMonthly || [], maxYears * 12);
  const bsRows = getMonthlyDisplayRows(results.bsMonthly || [], maxYears * 12);
  const nodeRows = getMonthlyDisplayRows(results.nodeOutputs || [], maxYears * 12);
  const years = [];

  for (let year = 1; year <= maxYears; year += 1) {
    const start = (year - 1) * 12;
    const end = year * 12;
    const plSlice = plRows.slice(start, end);
    const bsSlice = bsRows.slice(start, end);
    const nodeSlice = nodeRows.slice(start, end);
    if (!plSlice.length && !bsSlice.length && !nodeSlice.length) break;

    const row = { period: `Y${year}` };

    const samplePl = plSlice[0] || {};
    Object.keys(samplePl)
      .filter((key) => key !== "date" && key !== "month_index")
      .forEach((key) => {
        row[key] = round2(plSlice.reduce((acc, item) => acc + Number(item?.[key] || 0), 0));
      });

    const sampleBs = bsSlice[bsSlice.length - 1] || {};
    Object.keys(sampleBs)
      .filter((key) => key !== "date" && key !== "month_index")
      .forEach((key) => {
        row[key] = sampleBs[key];
      });

    row.csm_opening_display = year === 1
      ? Math.abs(Number(results.summary?.bel0 || 0))
      : Math.abs(Number(years[year - 2]?.csm_closing_display || 0));
    row.new_business_display = 0;
    row.csm_interest_movement = round2(-nodeSlice.reduce((acc, item) => acc + Number(item?.csm_interest || 0), 0));
    row.fcf_change_movement = round2(-nodeSlice.reduce((acc, item) => acc + Number(item?.unlocking_to_csm || 0), 0));
    row.fx_change_movement = 0;
    row.csm_release_movement = round2(nodeSlice.reduce((acc, item) => acc + Number(item?.csm_amortization || 0), 0));
    row.csm_closing_display = Math.abs(Number(nodeSlice[nodeSlice.length - 1]?.csm_closing ?? sampleBs?.reinsurance_contract_assets_csm ?? 0));

    years.push(row);
  }

  return years;
}
function clickableDotFactory(onPointClick, radius = 4) {
  return function ClickableDot(props) {
    const { cx, cy, stroke, fill, payload } = props;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    return (
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={fill || "#ffffff"}
        stroke={stroke || "#4c6ef5"}
        strokeWidth={2}
        style={{ cursor: "pointer" }}
        onClick={() => onPointClick?.(payload)}
      />
    );
  };
}

function buildAttributionTree(row, baseRow) {
  const currentIfie = sumNumbers(row?.csm_interest_expense, row?.bel_locked_interest_expense);
  const baseIfie = sumNumbers(baseRow?.csm_interest_expense, baseRow?.bel_locked_interest_expense);
  const currentInsuranceServiceResult = sumNumbers(row?.actual_claim_income, row?.csm_release_income, 0, row?.expected_claim_expense, 0);
  const baseInsuranceServiceResult = sumNumbers(baseRow?.actual_claim_income, baseRow?.csm_release_income, 0, baseRow?.expected_claim_expense, 0);
  const currentInvestmentServiceResult = sumNumbers(row?.investment_return_income, currentIfie);
  const baseInvestmentServiceResult = sumNumbers(baseRow?.investment_return_income, baseIfie);

  const leaf = (id, label, value, baseValue, color) => ({
    id,
    label,
    value: value || 0,
    delta: (value || 0) - (baseValue || 0),
    color,
    children: [],
  });

  return {
    id: 'tci',
    label: '综合收益总额',
    value: row?.total_comprehensive_income || 0,
    delta: Number(row?.total_comprehensive_income || 0) - Number(baseRow?.total_comprehensive_income || 0),
    color: '#1f3c88',
    children: [
      {
        id: 'net_income',
        label: '净利润',
        value: row?.net_income || 0,
        delta: Number(row?.net_income || 0) - Number(baseRow?.net_income || 0),
        color: '#2f6fed',
        children: [
          {
            id: 'insurance_service_result',
            label: '保险服务结果',
            value: currentInsuranceServiceResult,
            delta: currentInsuranceServiceResult - baseInsuranceServiceResult,
            color: '#12b886',
            children: [
              leaf('actual_claim_income', '实际摊回死伤医疗给付的保险成分', row?.actual_claim_income || 0, baseRow?.actual_claim_income || 0, '#4c6ef5'),
              leaf('csm_release_income', 'CSM释放', row?.csm_release_income || 0, baseRow?.csm_release_income || 0, '#7c3aed'),
              leaf('ra_release', 'RA释放', 0, 0, '#15aabf'),
              leaf('expected_claim_expense', '预期摊回死伤医疗给付的保险成分', row?.expected_claim_expense || 0, baseRow?.expected_claim_expense || 0, '#f59f00'),
              leaf('loss_accretion', '亏损加剧', 0, 0, '#fa5252'),
            ],
          },
          {
            id: 'investment_service_result',
            label: '投资服务结果',
            value: currentInvestmentServiceResult,
            delta: currentInvestmentServiceResult - baseInvestmentServiceResult,
            color: '#0c8599',
            children: [
              leaf('investment_return_income', '投资收益', row?.investment_return_income || 0, baseRow?.investment_return_income || 0, '#2b8a3e'),
              leaf('ifie_pl_interest', 'IFIE PL 利息', currentIfie, baseIfie, '#e8590c'),
            ],
          },
        ],
      },
      {
        id: 'oci',
        label: 'OCI',
        value: row?.oci || 0,
        delta: Number(row?.oci || 0) - Number(baseRow?.oci || 0),
        color: '#f08c00',
        children: [],
      },
    ],
  };
}

function getAllExpandableNodeIds(node) {
  if (!node) return [];
  const current = node.children?.length ? [node.id] : [];
  return current.concat(...(node.children || []).map((child) => getAllExpandableNodeIds(child)));
}

function layoutAttributionTree(tree, expandedIds) {
  const root = tree || { id: 'empty', label: '综合收益总额', value: 0, color: '#1f3c88', children: [] };
  const levelGap = 270;
  const verticalGap = 92;
  const rootAbs = Math.max(Math.abs(root.value || 0), 1);
  const nodes = [];
  const links = [];

  function leafCount(node) {
    if (!node.children?.length || !expandedIds.has(node.id)) return 1;
    return node.children.reduce((sum, child) => sum + leafCount(child), 0);
  }

  function walk(node, depth, top) {
    const leaves = leafCount(node);
    const centerY = top + ((leaves - 1) * verticalGap) / 2 + 70;
    const x = 90 + depth * levelGap;
    nodes.push({ ...node, x, y: centerY });
    if (node.children?.length && expandedIds.has(node.id)) {
      let cursor = top;
      node.children.forEach((child) => {
        const childLeaves = leafCount(child);
        const childLayout = walk(child, depth + 1, cursor);
        links.push({
          id: `${node.id}-${child.id}`,
          x1: x + 10,
          y1: centerY,
          x2: childLayout.x - 10,
          y2: childLayout.y,
          cx1: x + 90,
          cx2: childLayout.x - 90,
          color: child.value >= 0 ? '#91a7ff' : '#ffa94d',
          strokeWidth: 2 + 14 * Math.abs(Number(child.value || 0)) / rootAbs,
        });
        cursor += childLeaves * verticalGap;
      });
    }
    return { x, y: centerY, leaves };
  }

  const totalLeaves = leafCount(root);
  walk(root, 0, 30);
  return {
    nodes,
    links,
    width: 120 + (Math.max(...nodes.map((node) => node.x), 90) + 380),
    height: Math.max(260, totalLeaves * verticalGap + 80),
  };
}
function cloneNodeDefaults() {
  return JSON.parse(JSON.stringify(NODE_DEFAULTS));
}

function parseInputValue(key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return PERCENT_KEYS.includes(key) ? numeric / 100 : numeric;
}

function getScenarioKeyLabel(key) {
  return SCENARIO_KEY_LABELS[key] || key;
}

function formatScenarioValue(key, value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return String(value);
  if (PERCENT_KEYS.includes(key.split(".").slice(-1)[0]) || PERCENT_KEYS.includes(key)) {
    return `${formatInputNumber(raw * 100, 2)}%`;
  }
  return Number.isInteger(raw) ? String(raw) : raw.toFixed(4);
}


function formatScenarioRate(value) {
  const pct = Number(value || 0) * 100;
  if (!Number.isFinite(pct)) return "0.00";
  return formatInputNumber(pct, 2);
}

function formatCell(value, column = "") {
  if (value === null || value === undefined || value === "") return "-";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const isDfColumn = String(column).toLowerCase().includes("df") || String(column).includes("计息率");
    return numeric.toLocaleString("zh-CN", {
      minimumFractionDigits: isDfColumn ? 5 : 2,
      maximumFractionDigits: isDfColumn ? 5 : 2,
    });
  }
  return String(value);
}

function isNumericValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function isNumericColumn(rows, column) {
  return rows.some((row) => isNumericValue(row[column]));
}

function sumNumbers(...values) {
  return round2(values.reduce((acc, value) => acc + Number(value || 0), 0));
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}















































































const ChatPanel = memo(function ChatPanel({ activeTab, activeScenario }) {
  const inputRef = useRef(null);
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", content: "你可以在这里询问公式、节点、报表口径，或直接追问具体数字的计算来源" },
  ]);
  const [chatError, setChatError] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const sessionId = useMemo(() => {
    if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `session-${Date.now()}`;
  }, []);

  async function sendChatAsync() {
    const question = inputRef.current?.value?.trim() || "";
    if (!question || chatLoading) return;

    const history = chatMessages.filter((message) => message.role === "user" || message.role === "assistant");
    const nextUserMessage = { role: "user", content: question };

    setChatExpanded(true);
    setChatMessages((prev) => [...prev, nextUserMessage]);
    if (inputRef.current) inputRef.current.value = "";
    setChatError("");
    setChatLoading(true);

    const traceContext = buildChatTraceContext(question, activeScenario);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          activeTab,
          traceContext,
          messages: [...history, nextUserMessage].map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "问答请求失败");
      }

      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: payload.reply || "当前没有拿到有效回复。" },
      ]);
    } catch (error) {
      setChatError(error.message || "问答请求失败");
    } finally {
      setChatLoading(false);
    }
  }

  return (
    <>
      {chatExpanded ? <div className="chatbox-backdrop" onClick={() => setChatExpanded(false)} /> : null}
      <section className={`chatbox ${chatExpanded ? "expanded" : ""}`}>
        <div className="chatbox-head">
          <div className="chatbox-title">Actuarial Copilot</div>
          <button type="button" className="chatbox-toggle" onClick={() => setChatExpanded((prev) => !prev)}>
            {chatExpanded ? "收起" : "放大"}
          </button>
        </div>
        <div className="chat-list">
          {chatMessages.slice(chatExpanded ? -12 : -4).map((message, index) => (
            <div key={index} className={`chat-row ${message.role || "assistant"}`}>
              <div className="chat-role">{message.role === "user" ? "你" : "Copilot"}</div>
              <div className="chat-content">{message.content}</div>
            </div>
          ))}
        </div>
        {chatError ? <div className="chat-error">{chatError}</div> : null}
        <div className="chat-input-wrap">
          <input
            ref={inputRef}
            defaultValue=""
            onFocus={() => setChatExpanded(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendChatAsync();
              }
            }}
            placeholder="例如：Y2的CSM释放怎么来的？或 29,290,526 这个数字怎么来的？也支持 BEL @ CR、投资收益、综合收益总额。"
          />
          <button onClick={sendChatAsync} disabled={chatLoading}>
            {chatLoading ? "思考中..." : "发送"}
          </button>
        </div>
        <div className="chat-helper">
          当前优先支持：CSM释放、CSM计息、BEL(锁定)计息、OCI、净利润、净资产、BEL(当期)、BEL @ CR、投资收益、综合收益总额、CSM期末余额，也支持直接粘贴数字提问。
        </div>
      </section>
    </>
  );
});









