# IFRS 17 White-box Demo

This repository now includes a React-based UI demo that follows the 3-column layout:
- Left: Pipeline navigation (Final Report, Charts, Node0-Node7)
- Center: Main content with always-on Chatbox
- Right: Global variables panel + one-click Reset

## React Frontend (Primary)

Path: `D:\CodeX\ifrs17-whitebox-demo\web`

### Run
```powershell
cd D:\CodeX\ifrs17-whitebox-demo\web
npm install
npm run dev
```

### Default assumptions
- `CSM计息率`: `4.00%`
- `CSM释放率`: `5.00%`
- `投资收益率`: `3.50%`

### Input contract
- Required columns:
  - `date`
  - `expected_premiums`
  - `actual_premiums`
  - `expected_claims`
  - `actual_claims`
  - `commission`
  - `df`
- Input values already carry their final sign:
  - `premium`: expense item, normally negative
  - `claim`: income item, normally positive
  - `commission`: income item, normally positive
- Current and locked BEL share the same `df` curve, but use it differently:
  - `BEL_current`: each period resets and starts discounting from the first point of `df`
  - `BEL_locked`: each period rolls forward and starts from that period's `df`
- Timing treatment:
  - `commission`: beginning of period, current period not discounted, but participates in current-period interest/investment return
  - `claim` / `premium`: end of period, participate in current-period discounting, but not in current-period interest

### Implemented behavior
- Scenario naming:
  - All defaults: `Global`
  - Changed variable(s): `<中文变量名>_<值>`
- Shadow Mode per Node:
  - On: create a new Scenario
  - Off: overwrite current active Scenario
- Final Report:
  - Compact Scenario cards
  - BEL0 summary above PL
  - PL and BS in Chinese headers
  - `date`/`month_index` hidden
  - Node monthly output in default-collapsed section
- Chart Analysis:
  - Multi-scenario monthly trend (Net Income/OCI)
  - Scenario Y1 comparison
  - Y1 attribution chart
- Node0-Node7:
  - Node explanation + formulas
  - Editable node variables
  - Shadow switch + run button
  - Top 10 row node calculation example
- Global panel:
  - Editable global vars in Chinese with percent display
  - `Reset` restores global and all node overrides

## Legacy Python Prototype
Old Streamlit/Python prototype remains in root and `src/ifrs17_demo` for reference.
