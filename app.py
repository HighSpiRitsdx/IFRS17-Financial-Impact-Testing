import numpy as np
import pandas as pd
import streamlit as st

from src.ifrs17_demo.engine import IFRS17Engine
from src.ifrs17_demo.exporter import to_excel_bytes
from src.ifrs17_demo.models import GlobalParameters, ScenarioConfig

st.set_page_config(page_title="IFRS 17 White-box Copilot Demo", layout="wide")
st.title("IFRS 17 智能利润测算与归因引擎 (Demo)")

with st.sidebar:
    st.header("Node 0: 全局参数")
    csm_acc = st.number_input("CSM计息率(年)", min_value=0.0, max_value=1.0, value=0.03, step=0.005)
    csm_rel = st.number_input("CSM释放率(年)", min_value=0.0, max_value=1.0, value=0.12, step=0.01)
    scenario_name = st.text_input("Scenario 名称", value="Scenario A")

    st.markdown("---")
    st.caption("冲突优先级: AI改参 > 节点局部 > 全局")

col_left, col_mid, col_right = st.columns([1.1, 2.2, 1.2])

with col_left:
    st.subheader("Pipeline")
    nodes = [
        "Node 1 现金流与偏差",
        "Node 2 双曲线贴现/BEL",
        "Node 3 风险调整(RA=0)",
        "Node 4 初始确认",
        "Node 5 IFIE/OCI",
        "Node 6 经验偏差与解锁",
        "Node 7 CSM摊销",
    ]
    for n in nodes:
        st.write(f"- {n}")

with col_mid:
    st.subheader("Workspace")
    uploaded = st.file_uploader("上传输入CSV", type=["csv"])

    st.caption("需要字段: date, expected/actual premiums/claims/expenses, locked_df, current_df")

    run_btn = st.button("确认运行 Shadow Run", type="primary")

with col_right:
    st.subheader("Node AI Chatbox (Demo Stub)")
    st.info("此版本先保留交互位，后续可接入节点上下文问答与改参API。")

st.markdown("---")
st.subheader("Global Delta Drawer")

if uploaded is not None:
    input_df = pd.read_csv(uploaded)
    st.write("输入预览(前12行)")
    st.dataframe(input_df.head(12), use_container_width=True)

    if run_btn:
        params = GlobalParameters(
            csm_accretion_rate_annual=float(csm_acc),
            csm_amortization_rate_annual=float(csm_rel),
        )
        scenario = ScenarioConfig(name=scenario_name)
        engine = IFRS17Engine(params=params, scenario=scenario)
        results = engine.run(input_df)

        st.success("Shadow Run 完成。")

        st.markdown("### P&L (M1 + Y1~Y5)")
        st.dataframe(results["pl_report"], use_container_width=True)

        st.markdown("### BS (M1 + Y1~Y5)")
        st.dataframe(results["bs_report"], use_container_width=True)

        st.markdown("### Node 月度输出（前24个月）")
        st.dataframe(results["node_outputs"].head(24), use_container_width=True)

        excel_bytes = to_excel_bytes(results)
        st.download_button(
            "下载 Excel 结果",
            data=excel_bytes,
            file_name=f"ifrs17_demo_{scenario_name.replace(' ', '_')}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

        st.markdown("### 利润趋势图（月度）")
        chart_df = results["pl_monthly"][["date", "net_income", "oci"]].copy()
        chart_df = chart_df.set_index("date")
        st.line_chart(chart_df)

        st.markdown("### 利润归因瀑布（简化）")
        first_12 = results["pl_monthly"].iloc[:12]
        bridge = pd.DataFrame(
            {
                "component": ["Insurance Revenue", "Experience Adj", "IFIE P&L", "OCI"],
                "amount": [
                    float(first_12["insurance_service_revenue"].sum()),
                    float(first_12["experience_adjustment"].sum()),
                    float(first_12["ifie_pnl"].sum()),
                    float(first_12["oci"].sum()),
                ],
            }
        )
        st.bar_chart(bridge.set_index("component"))
else:
    st.warning("请先上传输入CSV。")
