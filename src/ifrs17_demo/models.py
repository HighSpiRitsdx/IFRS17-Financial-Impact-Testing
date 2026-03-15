from dataclasses import dataclass


@dataclass
class GlobalParameters:
    csm_accretion_rate_annual: float
    csm_amortization_rate_annual: float
    investment_return_rate_annual: float = 0.035


@dataclass
class ScenarioConfig:
    name: str
    claim_variance_to_pnl: bool = True
    premium_variance_to_csm: bool = True
    expense_variance_to_csm: bool = True
