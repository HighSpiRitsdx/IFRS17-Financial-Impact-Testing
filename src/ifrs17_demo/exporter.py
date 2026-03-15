from __future__ import annotations

from io import BytesIO
from typing import Dict

import pandas as pd


def to_excel_bytes(results: Dict[str, pd.DataFrame]) -> bytes:
    buffer = BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        results["inputs"].to_excel(writer, sheet_name="Inputs", index=False)
        results["node_outputs"].to_excel(writer, sheet_name="Node Outputs", index=False)
        results["pl_report"].to_excel(writer, sheet_name="P&L(1M+5Y)", index=False)
        results["bs_report"].to_excel(writer, sheet_name="BS(1M+5Y)", index=False)
    return buffer.getvalue()
