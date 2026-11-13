// Read-only fallback: an .xlsx download of the master sheet, kept outside the repo.
// Useful if Google is unreachable during a demo. Logging is turned off in this mode.
const ExcelJS = require("exceljs");
const { TABS, buildData } = require("../mapData");

function cellValue(v) {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return v.result;
    if (v.richText) return v.richText.map(t => t.text).join("");
    if ("text" in v) return v.text;
  }
  return v;
}

function createXlsxSource({ file }) {
  if (!file) throw new Error("Set XLSX_FILE in .env");
  return {
    mode: "xlsx",
    canWrite: false,
    cacheMs: 60 * 1000,
    async read() {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const tabs = {};
      for (const t of TABS) {
        const ws = wb.getWorksheet(t);
        // getSheetValues() is 1-based with gaps; shift to 0-based dense rows.
        tabs[t] = ws ? ws.getSheetValues().slice(1).map(r => Array.from((r || []).slice(1), cellValue)) : [];
      }
      return buildData(tabs);
    },
  };
}

module.exports = { createXlsxSource };
