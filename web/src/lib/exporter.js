import * as XLSX from "xlsx";

export function exportScenarioWorkbook(scenarios) {
  const wb = XLSX.utils.book_new();

  scenarios.forEach((s) => {
    const pl = XLSX.utils.json_to_sheet(s.results.plReport);
    const bs = XLSX.utils.json_to_sheet(s.results.bsReport);
    XLSX.utils.book_append_sheet(wb, pl, `${shortenName(s.name)}_PL`);
    XLSX.utils.book_append_sheet(wb, bs, `${shortenName(s.name)}_BS`);
  });

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return blob;
}

function shortenName(name) {
  return name.length > 20 ? name.slice(0, 20) : name;
}
