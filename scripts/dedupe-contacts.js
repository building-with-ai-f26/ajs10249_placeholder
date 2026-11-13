// Removes duplicate people from the Contacts tab (same name + same firm), e.g. after an import.
// Usage: npm run dedupe            (dry run: prints counts only, changes nothing)
//        npm run dedupe -- --apply (backs up the tab first, then merges and deletes)
// Dry run by default: prints counts only (no contact data). With --apply: backs up the tab,
// fills blanks in the kept row from its copies, repoints IDs in other tabs, deletes the copies.
const fs = require("fs");
const { auth, sheets } = require("@googleapis/sheets");
const APPLY = process.argv.includes("--apply");
const BACKUP = "Contacts_backup_" + new Date().toLocaleDateString("en-CA");
const REF_TABS = { Outreach_Log: "Contact_ID", Event_Attendance: "Contact_ID", Panelists: "Contact_ID",
  Sponsorship_Commitments: "Contact_ID", Organizations: "Primary_Contact_ID", Relationships: "Contact_ID" };
const str = v => (v == null ? "" : String(v).trim());
const isFormula = v => typeof v === "string" && v.startsWith("=");
const col = i => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const norm = s => str(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

(async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE, "utf8"));
  const c = raw.web || raw.installed;
  const client = new auth.OAuth2(c.client_id, c.client_secret);
  client.setCredentials(JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_FILE, "utf8")));
  const api = sheets({ version: "v4", auth: client });
  const id = process.env.GOOGLE_SHEET_ID;

  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties(sheetId,title,index)" });
  const tabs = Object.fromEntries(meta.data.sheets.map(s => [s.properties.title, s.properties]));
  const values = (await api.spreadsheets.values.get({ spreadsheetId: id, range: "'Contacts'", valueRenderOption: "FORMULA" })).data.values;
  const H = values[0].map(str);
  const iId = H.indexOf("Contact_ID"), iF = H.indexOf("First_Name"), iL = H.indexOf("Last_Name"), iO = H.indexOf("Organization");
  console.log("Contacts rows with data:", values.length - 1, "| formula cells:", values.flat().filter(isFormula).length);

  const keep = new Map(); const plan = []; // plan: {row, keptRow}
  values.forEach((r, i) => {
    if (i === 0) return;
    const name = norm(str(r[iF]) + str(r[iL]));
    if (!name) return;
    const k = name + "|" + norm(r[iO]);
    if (!keep.has(k)) keep.set(k, i); else plan.push({ row: i, kept: keep.get(k) });
  });

  // Fill blanks in kept rows from the copies; count real conflicts (both filled, different).
  const fills = new Map(); let conflicts = 0; const conflictCols = {};
  for (const { row, kept } of plan) {
    H.forEach((h, j) => {
      if (j === iId) return;
      const a = (values[kept] || [])[j], b = (values[row] || [])[j];
      const filled = fills.get(`${kept}:${j}`);
      const cur = filled !== undefined ? filled : a;
      if (!str(cur) && str(b) && !isFormula(b)) fills.set(`${kept}:${j}`, b);
      else if (str(cur) && str(b) && str(cur) !== str(b)) {
        if ((h === "Tags" || h === "Notes") && !str(cur).includes(str(b))) { fills.set(`${kept}:${j}`, str(cur) + "; " + str(b)); conflictCols[h + " (combined)"] = (conflictCols[h + " (combined)"] || 0) + 1; }
        else { conflicts++; conflictCols[h] = (conflictCols[h] || 0) + 1; }
      }
    });
  }
  console.log("people kept:", keep.size, "| duplicate rows to delete:", plan.length, "| blank cells filled from copies:", fills.size,
    "| conflicts (kept first row's value):", conflicts, JSON.stringify(conflictCols));

  // IDs that disappear -> the kept row's ID.
  const remap = {};
  for (const { row, kept } of plan) {
    const from = str(values[row][iId]), to = str(values[kept][iId]);
    if (from && from !== to) remap[from] = to;
  }
  const refUpdates = [];
  for (const [tab, field] of Object.entries(REF_TABS)) {
    if (!tabs[tab]) continue;
    const v = (await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'`, valueRenderOption: "FORMULA" })).data.values || [];
    const ci = (v[0] || []).map(str).indexOf(field);
    if (ci < 0) continue;
    let n = 0;
    v.forEach((r, i) => { if (i > 0 && remap[str((r || [])[ci])] && !isFormula(r[ci])) { n++; refUpdates.push({ range: `'${tab}'!${col(ci)}${i + 1}`, values: [[remap[str(r[ci])]]] }); } });
    console.log(`  ${tab}.${field}: ${n} reference(s) to repoint`);
  }
  if (!APPLY) return console.log("Dry run only. Nothing changed.");

  // 1) Backup copy of the whole tab.
  if (tabs[BACKUP]) throw new Error("Backup tab already exists; stopping so nothing is overwritten.");
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ duplicateSheet: {
    sourceSheetId: tabs.Contacts.sheetId, newSheetName: BACKUP, insertSheetIndex: Object.keys(tabs).length } }] } });
  console.log("backup tab created:", BACKUP);
  // 2) Fill blanks in kept rows, 3) repoint references.
  const data = [...fills].map(([k, v]) => { const [r, j] = k.split(":").map(Number); return { range: `'Contacts'!${col(j)}${r + 1}`, values: [[v]] }; })
    .concat(refUpdates);
  if (data.length) await api.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: "RAW", data } });
  console.log("cells updated:", data.length);
  // 4) Delete duplicate rows, bottom-up so row numbers don't shift under us.
  const rows = plan.map(p => p.row).sort((a, b) => b - a);
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: rows.map(r => ({
    deleteDimension: { range: { sheetId: tabs.Contacts.sheetId, dimension: "ROWS", startIndex: r, endIndex: r + 1 } } })) } });
  const after = (await api.spreadsheets.values.get({ spreadsheetId: id, range: "'Contacts'" })).data.values;
  console.log("rows deleted:", rows.length, "| Contacts rows with data now:", after.length - 1);
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
