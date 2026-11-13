// Live Google Sheet, accessed as the person who signs in with Google (OAuth).
// No service-account key: the app holds a revocable sign-in token stored outside
// the repo (GOOGLE_TOKEN_FILE). Writes only ever touch the Outreach_Log tab.
const fs = require("fs/promises");
const crypto = require("crypto");
const { auth, sheets } = require("@googleapis/sheets");
const { TABS, buildData, headerOf, str } = require("../mapData");

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
      const res = await api.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: TABS.map(t => `'${t}'`),
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      });
      const tabs = {};
      TABS.forEach((t, i) => { tabs[t] = res.data.valueRanges[i].values || []; });
      return buildData(tabs);
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
      const isFormula = v => typeof v === "string" && v.startsWith("=");
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
