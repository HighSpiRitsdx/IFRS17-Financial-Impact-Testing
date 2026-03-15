from __future__ import annotations

from dataclasses import asdict
from typing import Dict

import numpy as np
import pandas as pd

from .models import GlobalParameters, ScenarioConfig

REQUIRED_COLUMNS = [
    "date",
    "expected_premiums",
    "actual_premiums",
    "expected_claims",
    "actual_claims",
    "commission",
    "df",
]

OPTIONAL_COLUMNS = ["expected_expenses", "actual_expenses"]

COLUMN_ALIASES = {
    "$date": "date",
    "dt": "date",
    "expected premium": "expected_premiums",
    "actual premium": "actual_premiums",
    "expected claim": "expected_claims",
    "actual claim": "actual_claims",
    "expected expense": "expected_expenses",
    "actual expense": "actual_expenses",
    "commission": "commission",
    "commissions": "commission",
    "df": "df",
    "discount factor": "df",
    "locked_df": "df",
    "current_df": "df",
    "locked curve": "df",
    "current curve": "df",
}


class IFRS17Engine:
    def __init__(self, params: GlobalParameters, scenario: ScenarioConfig):
        self.params = params
        self.scenario = scenario

    def run(self, df: pd.DataFrame) -> Dict[str, pd.DataFrame]:
        base = self._prepare(df)
        n1 = self._node1_cashflow_variance(base)
        n2 = self._node2_bel(n1)
        n3 = self._node3_ra(n2)
        n4 = self._node4_initial_recognition(n3)
        n5 = self._node5_ifie(n4)
        n6 = self._node6_experience_unlocking(n5)
        n7 = self._node7_csm_amortization(n6)
        assets = self._build_asset_ledger(n7)
        merged = pd.concat([n7.reset_index(drop=True), assets.reset_index(drop=True)], axis=1)
        pl = self._build_profit_statement(merged)
        bs = self._build_balance_sheet(merged)

        return {
            "inputs": base,
            "summary": pd.DataFrame({"metric": ["bel0"], "value": [round(float(n2.loc[0, "bel_current"]), 2)]}),
            "node_tables": {
                "node0": base,
                "node1": n1,
                "node2": n2,
                "node3": n3,
                "node4": n4,
                "node5": n5,
                "node6": n6,
                "node7": merged,
            },
            "node_outputs": merged,
            "pl_monthly": pl,
            "bs_monthly": bs,
            "pl_report": self._build_flow_report(pl),
            "bs_report": self._build_stock_report(bs),
            "meta": pd.DataFrame(
                {
                    "parameter": list(asdict(self.params).keys()) + ["scenario_name"],
                    "value": list(asdict(self.params).values()) + [self.scenario.name],
                }
            ),
        }

    def _normalize_columns(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        normalized = {}
        for col in out.columns:
            raw = str(col).replace("\ufeff", "").strip()
            lower = raw.lower()
            canonical = lower.replace("-", "_").replace(" ", "_")
            canonical = COLUMN_ALIASES.get(canonical, COLUMN_ALIASES.get(lower, canonical))
            normalized[col] = canonical
        return out.rename(columns=normalized)

    def _prepare(self, df: pd.DataFrame) -> pd.DataFrame:
        out = self._normalize_columns(df)
        missing = [c for c in REQUIRED_COLUMNS if c not in out.columns]
        if missing:
            raise ValueError(f"Missing required columns: {missing}. Received columns: {list(out.columns)}")

        out = out.copy()
        out["date"] = pd.to_datetime(out["date"])
        out = out.sort_values("date").reset_index(drop=True)

        out["df"] = pd.to_numeric(out["df"], errors="coerce")
        out["df"] = out["df"].interpolate(method="linear", limit_direction="both")

        for col in REQUIRED_COLUMNS:
            if col == "date":
                continue
            out[col] = pd.to_numeric(out[col].astype(str).str.replace(",", "", regex=False), errors="coerce").fillna(0.0)

        for col in OPTIONAL_COLUMNS:
            if col not in out.columns:
                out[col] = 0.0
            out[col] = pd.to_numeric(out[col].astype(str).str.replace(",", "", regex=False), errors="coerce").fillna(0.0)

        out["month_index"] = np.arange(1, len(out) + 1)
        return out[["date", *[c for c in REQUIRED_COLUMNS if c != "date"], *OPTIONAL_COLUMNS, "month_index"]]

    def _node1_cashflow_variance(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["exp_net_cf"] = (
            out["expected_claims"] + out["expected_expenses"] + out["commission"] + out["expected_premiums"]
        )
        out["act_net_cf"] = out["actual_claims"] + out["actual_expenses"] + out["commission"] + out["actual_premiums"]
        out["var_premium"] = out["actual_premiums"] - out["expected_premiums"]
        out["var_claim"] = out["actual_claims"] - out["expected_claims"]
        out["var_expense"] = out["actual_expenses"] - out["expected_expenses"]
        out["var_net_cf"] = out["act_net_cf"] - out["exp_net_cf"]
        return out

    def _get_df_at(self, dfs: np.ndarray, index: int) -> float:
        if index < 0:
            return 1.0
        if index >= len(dfs):
            return float(dfs[-1])
        return float(dfs[index])

    def _expected_eop_flow(self, row: pd.Series) -> float:
        return float(row["expected_claims"] + row["expected_expenses"] + row["expected_premiums"])

    def _pv_current_reset(self, df: pd.DataFrame) -> np.ndarray:
        dfs = df["df"].to_numpy(dtype=float)
        out = np.zeros(len(df))
        for i in range(len(df)):
            pv = 0.0
            for j in range(i, len(df)):
                curve_index = j - i
                end_df = self._get_df_at(dfs, curve_index)
                bop_df = self._get_df_at(dfs, curve_index - 1)
                pv += self._expected_eop_flow(df.loc[j]) * end_df
                pv += float(df.loc[j, "commission"]) * bop_df
            out[i] = pv
        return out

    def _pv_locked(self, df: pd.DataFrame) -> np.ndarray:
        dfs = df["df"].to_numpy(dtype=float)
        out = np.zeros(len(df))
        for i in range(len(df)):
            pv = 0.0
            current_eop_anchor = self._get_df_at(dfs, i)
            current_bop_anchor = self._get_df_at(dfs, i - 1)
            for j in range(i, len(df)):
                end_df = self._get_df_at(dfs, j) / current_eop_anchor if current_eop_anchor != 0 else 0.0
                bop_df = self._get_df_at(dfs, j - 1) / current_bop_anchor if current_bop_anchor != 0 else 0.0
                pv += self._expected_eop_flow(df.loc[j]) * end_df
                pv += float(df.loc[j, "commission"]) * bop_df
            out[i] = pv
        return out

    def _node2_bel(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["bel_current"] = self._pv_current_reset(out)
        out["bel_locked"] = self._pv_locked(out)
        out["delta_bel"] = out["bel_current"] - out["bel_locked"]
        return out

    def _node3_ra(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["ra_opening"] = 0.0
        out["ra_interest"] = 0.0
        out["ra_release"] = 0.0
        out["ra_closing"] = 0.0

        for i in range(len(out)):
            ra_bop = abs(out.loc[i, "bel_current"]) * self.scenario.ra_ratio_override
            ra_eop = abs(out.loc[i + 1, "bel_current"]) * self.scenario.ra_ratio_override if i < len(out) - 1 else 0.0
            monthly_rate = out.loc[i, "df"] / out.loc[i + 1, "df"] - 1.0 if i < len(out) - 1 and out.loc[i + 1, "df"] != 0 else 0.0
            ra_interest = ra_bop * monthly_rate
            out.loc[i, "ra_opening"] = ra_bop
            out.loc[i, "ra_interest"] = ra_interest
            out.loc[i, "ra_release"] = ra_bop - ra_eop + ra_interest
            out.loc[i, "ra_closing"] = ra_eop
        return out

    def _node4_initial_recognition(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["fcf_day1"] = 0.0
        out.loc[0, "fcf_day1"] = out.loc[0, "bel_current"] + out.loc[0, "ra_opening"]
        out["day1_loss_component"] = 0.0
        out["initial_csm"] = 0.0
        out.loc[0, "day1_loss_component"] = 0.0
        out.loc[0, "initial_csm"] = -(out.loc[0, "fcf_day1"])
        return out

    def _node5_ifie(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["ifie_pnl_locked_interest"] = 0.0
        out["ifie_oci_discount_effect"] = 0.0

        delta = out["delta_bel"].to_numpy(dtype=float)
        out.loc[:, "ifie_oci_discount_effect"] = np.r_[delta[0], np.diff(delta)]

        for i in range(len(out)):
            monthly_rate = 1.0 - out.loc[i, "df"] / out.loc[i - 1, "df"] if i > 0 and out.loc[i - 1, "df"] != 0 else 0.0
            out.loc[i, "ifie_pnl_locked_interest"] = out.loc[i, "bel_locked"] * monthly_rate if i > 0 else 0.0
        return out

    def _node6_experience_unlocking(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["experience_to_pnl"] = out["var_claim"] + out["var_expense"]
        out["unlocking_to_csm"] = out["var_premium"]
        return out

    def _node7_csm_amortization(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["csm_opening"] = 0.0
        out["csm_interest"] = 0.0
        out["csm_pre_amort"] = 0.0
        out["csm_amortization"] = 0.0
        out["csm_closing"] = 0.0

        monthly_acc = self.params.csm_accretion_rate_annual / 12.0
        monthly_rel = self.params.csm_amortization_rate_annual / 12.0

        for i in range(len(out)):
            opening = out.loc[i - 1, "csm_closing"] if i > 0 else out.loc[i, "initial_csm"]
            interest = opening * monthly_acc if i > 0 else 0.0
            pre_amort = opening + interest + out.loc[i, "unlocking_to_csm"]
            amort = pre_amort * monthly_rel if i > 0 else 0.0
            closing = pre_amort - amort

            out.loc[i, "csm_opening"] = opening
            out.loc[i, "csm_interest"] = interest
            out.loc[i, "csm_pre_amort"] = pre_amort
            out.loc[i, "csm_amortization"] = amort
            out.loc[i, "csm_closing"] = closing
        return out

    def _build_asset_ledger(self, df: pd.DataFrame) -> pd.DataFrame:
        rate = self.params.investment_return_rate_annual / 12.0
        out = pd.DataFrame(index=df.index)
        out["investment_base"] = 0.0
        out["investment_return"] = 0.0
        out["investment_assets"] = 0.0

        for i in range(len(df)):
            opening = out.loc[i - 1, "investment_assets"] if i > 0 else 0.0
            investable_base = max(opening, 0.0) if i == 0 else max(opening + df.loc[i, "commission"], 0.0)
            investment_return = 0.0 if i == 0 else investable_base * rate
            closing = (
                opening
                + df.loc[i, "commission"]
                + df.loc[i, "actual_claims"]
                + df.loc[i, "actual_premiums"]
                + df.loc[i, "actual_expenses"]
                + investment_return
            )
            out.loc[i, "investment_base"] = investable_base
            out.loc[i, "investment_return"] = investment_return
            out.loc[i, "investment_assets"] = closing
        return out

    def _build_profit_statement(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df[["date", "month_index"]].copy()
        out["actual_claim_income"] = df["actual_claims"]
        out["expected_claim_expense"] = -df["expected_claims"]
        out["csm_release_income"] = -df["csm_amortization"]
        out["csm_interest_expense"] = df["csm_interest"]
        out["bel_locked_interest_expense"] = df["ifie_pnl_locked_interest"]
        out["investment_return_income"] = df["investment_return"]
        out["oci"] = df["ifie_oci_discount_effect"]
        out["net_income"] = (
            out["actual_claim_income"]
            + out["expected_claim_expense"]
            + out["csm_release_income"]
            + out["csm_interest_expense"]
            + out["bel_locked_interest_expense"]
            + out["investment_return_income"]
        )
        out["total_comprehensive_income"] = out["net_income"] + out["oci"]
        return out.round(2)

    def _build_balance_sheet(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df[["date", "month_index"]].copy()
        out["reinsurance_contract_assets_commission"] = df["commission"].cumsum()
        out["reinsurance_contract_assets_claims"] = df["actual_claims"].cumsum()
        out["reinsurance_contract_assets_premiums_payable"] = df["actual_premiums"].cumsum()
        out["reinsurance_contract_assets_bel_cr"] = df["bel_current"] - df["exp_net_cf"]
        out["reinsurance_contract_assets_csm"] = df["csm_closing"]
        out["financial_assets_investment_return"] = df["investment_return"].cumsum()
        out["cash_in_bank"] = 0.0

        item_cols = [
            "reinsurance_contract_assets_commission",
            "reinsurance_contract_assets_claims",
            "reinsurance_contract_assets_premiums_payable",
            "reinsurance_contract_assets_bel_cr",
            "reinsurance_contract_assets_csm",
            "financial_assets_investment_return",
            "cash_in_bank",
        ]
        out["total_assets"] = out[item_cols].clip(lower=0).sum(axis=1)
        out["total_liabilities"] = (-out[item_cols].clip(upper=0)).sum(axis=1)
        out["net_assets"] = out["total_assets"] - out["total_liabilities"]
        return out.round(2)

    def _display_rows(self, monthly_df: pd.DataFrame) -> pd.DataFrame:
        if len(monthly_df) <= 1:
            return monthly_df.iloc[0:0].copy()
        out = monthly_df.iloc[1:].copy().reset_index(drop=True)
        out["display_month_index"] = np.arange(1, len(out) + 1)
        return out

    def _build_flow_report(self, monthly_df: pd.DataFrame) -> pd.DataFrame:
        display = self._display_rows(monthly_df)
        if display.empty:
            return display

        m1_source = display.iloc[[0]].copy()
        m1_source.insert(0, "report_period", "M1")

        base = display.iloc[: min(60, len(display))].copy()
        yearly_rows = []
        for year in range(1, 6):
            subset = base.iloc[(year - 1) * 12 : year * 12].copy()
            if subset.empty:
                continue
            aggregate = subset.sum(numeric_only=True).to_dict()
            aggregate["display_month_index"] = float(subset.iloc[-1]["display_month_index"])
            aggregate["month_index"] = float(subset.iloc[-1]["month_index"])
            yearly_rows.append({"report_period": f"Y{year}", **aggregate})

        yearly = pd.DataFrame(yearly_rows)
        report = pd.concat([m1_source, yearly], ignore_index=True, sort=False)
        return report.drop(columns=["date", "month_index", "display_month_index"], errors="ignore").round(2)

    def _build_stock_report(self, monthly_df: pd.DataFrame) -> pd.DataFrame:
        display = self._display_rows(monthly_df)
        if display.empty:
            return display

        m1_source = display.iloc[[0]].copy()
        m1_source.insert(0, "report_period", "M1")

        base = display.iloc[: min(60, len(display))].copy()
        yearly_rows = []
        for year in range(1, 6):
            subset = base.iloc[(year - 1) * 12 : year * 12].copy()
            if subset.empty:
                continue
            yearly_rows.append({"report_period": f"Y{year}", **subset.iloc[-1].to_dict()})

        yearly = pd.DataFrame(yearly_rows)
        report = pd.concat([m1_source, yearly], ignore_index=True, sort=False)
        return report.drop(columns=["date", "month_index", "display_month_index"], errors="ignore").round(2)












