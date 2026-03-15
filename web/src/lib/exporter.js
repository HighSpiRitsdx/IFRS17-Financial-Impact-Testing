import * as XLSX from "xlsx";

export function exportScenarioWorkbook(scenarios) {
  const wb = XLSX.utils.book_new();

  scenarios.forEach((s) => {
    const pl = jsonToSheetWithHeaders(s.results.plReport);
    const bs = jsonToSheetWithHeaders(s.results.bsReport);
    const nodeOutputs = jsonToSheetWithHeaders(s.results.nodeOutputs);

    XLSX.utils.book_append_sheet(wb, pl, `${shortenName(s.name)}_PL`);
    XLSX.utils.book_append_sheet(wb, bs, `${shortenName(s.name)}_BS`);
    XLSX.utils.book_append_sheet(wb, nodeOutputs, `${shortenName(s.name)}_Node输出`);
  });

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return blob;
}

function jsonToSheetWithHeaders(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const headers = Array.from(
    safeRows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );
  return XLSX.utils.json_to_sheet(safeRows, { header: headers });
}

function shortenName(name) {
  return name.length > 20 ? name.slice(0, 20) : name;
}
