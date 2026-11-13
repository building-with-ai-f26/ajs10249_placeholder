// Live Google Sheet, accessed as the person who signs in with Google (OAuth).
// No service-account key: the app holds a revocable sign-in token stored outside
// the repo (GOOGLE_TOKEN_FILE). Writes touch only the app's log tabs (Outreach_Log,
// Relationships, Assignment_Log) and the Owner cell on Contacts and Organizations.
const fs = require("fs/promises");
const crypto = require("crypto");
const { auth, sheets } = require("@googleapis/sheets");
const { TABS, OPTIONAL_TABS, SheetShapeError, ConflictError, buildData, headerOf, str } = require("../mapData");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function colLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Text starting with = + - @ would be run as a formula; a leading ' keeps it plain text.
function asText(v) {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function isFormula(v) {
  return typeof v === "string" && v.startsWith("=");
}

function today() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
}

function createGoogleSource({ sheetId, clientFile, tokenFile, redirectUri }) {
  if (!sheetId || !clientFile || !tokenFile) {
    throw new Error("Set GOOGLE_SHEET_ID, GOOGLE_OAUTH_CLIENT_FILE and GOOGLE_TOKEN_FILE in .env");
  }
  const pendingStates = new Set();
  let client;
  let api;

  async function saveToken(tokens) {
    let current = {};
    try { current = JSON.parse(await fs.readFile(tokenFile, "utf8")); } catch {}
    await fs.writeFile(tokenFile, JSON.stringify({ ...current, ...tokens }, null, 2), { mode: 0o600 });
  }

  async function getClient() {
    if (client) return client;
    const raw = JSON.parse(await fs.readFile(clientFile, "utf8"));
    const c = raw.web || raw.installed;
    client = new auth.OAuth2(c.client_id, c.client_secret, redirectUri);
    // Google sends a fresh access token about every hour; keep the saved copy current.
    client.on("tokens", t => saveToken(t).catch(err => console.error("Could not save token:", err.message)));
    try { client.setCredentials(JSON.parse(await fs.readFile(tokenFile, "utf8"))); } catch {}
    api = sheets({ version: "v4", auth: client });
    return client;
  }

  // Tab names, so optional tabs are only read once they exist.
  let titles = null;
  async function tabTitles() {
    if (!titles) {
      const res = await api.spreadsheets.get({ spreadsheetId: sheetId, fields: "sheets.properties.title" });
      titles = new Set(res.data.sheets.map(s => s.properties.title));
    }
    return titles;
  }

  // Add a new tab with its header row the first time the app writes to it.
  async function ensureTab(name) {
    if ((await tabTitles()).has(name)) return;
    await api.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${name}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [OPTIONAL_TABS[name]] },
    });
    titles.add(name);
  }

  // Append one row to an app-owned tab, matching values to its header names.
  async function appendRow(name, fields) {
    await ensureTab(name);
    const res = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `'${name}'!1:1` });
    const header = headerOf(res.data.values || []);
    const row = header.map(h => (h in fields ? (h === "Date" ? fields[h] : asText(String(fields[h]))) : ""));
    await api.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${name}'!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
  }

  return {
    mode: "google",
    canWrite: true,
    cacheMs: 60 * 1000,

    async signedIn() {
      return Boolean((await getClient()).credentials.refresh_token);
    },

    async authUrl() {
      const state = crypto.randomBytes(16).toString("hex");
      pendingStates.add(state);
      setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);
      return (await getClient()).generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [SCOPE],
        state,
      });
    },

    async handleCallback(code, state) {
      if (!pendingStates.delete(state)) throw new Error("Sign-in expired or was not started here. Try again.");
      const c = await getClient();
      const { tokens } = await c.getToken(code);
      c.setCredentials(tokens);
      await saveToken(tokens);
    },

    async read() {
      await getClient();
      const titles = await tabTitles();
      const names = [...TABS, ...Object.keys(OPTIONAL_TABS).filter(t => titles.has(t))];
      const res = await api.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: names.map(t => `'${t}'`),
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      const tabs = {};
      names.forEach((t, i) => { tabs[t] = res.data.valueRanges[i].values || []; });
      return buildData(tabs);
    },

    // Change one Owner cell on Contacts or Organizations, found by ID/name (never by row
    // position), then record the change in Assignment_Log.
    async setOwner(kind, key, owner, expected) {
      await getClient();
      const tab = kind === "firm" ? "Organizations" : "Contacts";
      const keyName = kind === "firm" ? "Org_Name" : "Contact_ID";
      const res = await api.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tab}'`,
        valueRenderOption: "FORMULA",
      });
      const values = res.data.values || [];
      const header = headerOf(values);
      const keyCol = header.indexOf(keyName);
      const ownerCol = header.indexOf("Owner");
      if (keyCol === -1 || ownerCol === -1) throw new SheetShapeError(`The "${tab}" tab needs ${keyName} and Owner columns`);
      const r = values.findIndex((row, i) => i > 0 && str((row || [])[keyCol]) === key);
      if (r === -1) throw new ConflictError("That record is no longer in the sheet. Refresh the page.");
      const current = (values[r] || [])[ownerCol];
      if (isFormula(current)) throw new ConflictError("Owner is a formula in the sheet for this row; change it there.");
      const previous = str(current);
      if (expected !== undefined && previous !== expected) {
        throw new ConflictError(`Someone changed the owner in the sheet to "${previous || "nobody"}". Refresh and try again.`);
      }
      await api.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `'${tab}'!${colLetter(ownerCol)}${r + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[asText(owner)]] },
      });
      await appendRow("Assignment_Log", {
        Date: today(), Kind: kind === "firm" ? "Firm" : "Contact", Record: key, Previous_Owner: previous, New_Owner: owner,
      });
      return previous;
    },

    async addRelationship(rel, contact) {
      await getClient();
      await appendRow("Relationships", { ...rel, Contact: contact.Name });
    },

    // The Contact column is filled by a formula, so a plain append would land below
    // the formula block. Instead, write into the first row whose cells are all empty
    // or formulas, and never overwrite a formula.
    async appendOutreach(row, contact) {
      await getClient();
      const res = await api.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: "'Outreach_Log'",
        valueRenderOption: "FORMULA",
      });
      const values = res.data.values || [];
      const header = headerOf(values);
      let r = 1;
      while (r < values.length && (values[r] || []).some(v => str(v) && !isFormula(v))) r++;
      const existing = values[r] || [];

      const fields = { ...row, Contact: contact.Name };
      const data = [];
      for (const [name, value] of Object.entries(fields)) {
        const c = header.indexOf(name);
        if (c === -1 || isFormula(existing[c])) continue;
        data.push({
          range: `'Outreach_Log'!${colLetter(c)}${r + 1}`,
          values: [[name === "Date" ? value : asText(value)]],
        });
      }
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data },
      });
    },
  };
}

module.exports = { createGoogleSource };
