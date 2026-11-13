const path = require("path");
const express = require("express");
const { SheetShapeError } = require("./lib/mapData");
const { createSampleSource } = require("./lib/sources/sample");
const { createXlsxSource } = require("./lib/sources/xlsx");
const { createGoogleSource } = require("./lib/sources/google");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1"; // local only: anyone who can reach the server acts as the signed-in user
const MODE = process.env.DATA_SOURCE || "sample";

function createSource() {
  if (MODE === "google") {
    return createGoogleSource({
      sheetId: process.env.GOOGLE_SHEET_ID,
      clientFile: process.env.GOOGLE_OAUTH_CLIENT_FILE,
      tokenFile: process.env.GOOGLE_TOKEN_FILE,
      redirectUri: `http://localhost:${PORT}/oauth2callback`,
    });
  }
  if (MODE === "xlsx") return createXlsxSource({ file: process.env.XLSX_FILE });
  if (MODE === "sample") return createSampleSource();
  throw new Error(`Unknown DATA_SOURCE "${MODE}" (use sample, xlsx or google)`);
}

const source = createSource();
const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Real data is held in memory only and refreshed at most once a minute.
let cache = null;
async function getData() {
  if (cache && Date.now() - cache.at < source.cacheMs) return cache.data;
  const data = await source.read();
  cache = { data, at: Date.now() };
  return data;
}

async function needsSignIn() {
  return Boolean(source.signedIn) && !(await source.signedIn());
}

// Turn data-source failures into short, safe messages for the browser.
function sendSourceError(res, err, fallback) {
  if (err instanceof SheetShapeError) return res.status(500).json({ error: err.message });
  const msg = String((err && err.message) || "");
  if (/invalid_grant|No refresh token|invalid_token/i.test(msg) || (err && err.code === 401)) {
    return res.status(401).json({ error: "Google sign-in expired.", signIn: "/auth/google" });
  }
  if (err && err.code === 403) {
    return res.status(403).json({ error: "This Google account cannot open the sheet. Check it is shared with you." });
  }
  console.error(fallback + ":", msg);
  return res.status(500).json({ error: fallback });
}

app.get("/api/data", async (req, res) => {
  try {
    if (await needsSignIn()) {
      return res.status(401).json({ error: "Sign in with Google to load the sheet.", signIn: "/auth/google" });
    }
    res.json({ ...(await getData()), Source: { mode: source.mode, canWrite: source.canWrite } });
  } catch (err) {
    sendSourceError(res, err, "Could not load data");
  }
});

if (source.authUrl) {
  app.get("/auth/google", async (req, res) => {
    try {
      res.redirect(await source.authUrl());
    } catch (err) {
      console.error("Could not start sign-in:", err.message);
      res.status(500).send("Could not start Google sign-in. Check GOOGLE_OAUTH_CLIENT_FILE.");
    }
  });

  app.get("/oauth2callback", async (req, res) => {
    try {
      if (req.query.error) throw new Error(String(req.query.error));
      await source.handleCallback(String(req.query.code || ""), String(req.query.state || ""));
      cache = null;
      res.redirect("/");
    } catch (err) {
      console.error("Sign-in failed:", err.message);
      res.status(400).send('Google sign-in failed. <a href="/auth/google">Try again</a>.');
    }
  });
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Writes go one at a time so two quick submits can't land in the same row.
let writeQueue = Promise.resolve();

app.post("/api/outreach", (req, res) => {
  if (!source.canWrite) {
    return res.status(403).json({ error: "Logging is off while reading the Excel copy." });
  }
  const body = req.body || {};
  const row = {
    Date: clean(body.Date, 10),
    Contact_ID: clean(body.Contact_ID, 20),
    Channel: clean(body.Channel, 40),
    Owner: clean(body.Owner, 80),
    Summary: clean(body.Summary, 500),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.Date) || isNaN(Date.parse(row.Date))) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  }
  if (!row.Owner) return res.status(400).json({ error: "Owner is required" });
  if (!row.Summary) return res.status(400).json({ error: "Summary is required" });

  writeQueue = writeQueue.then(async () => {
    try {
      if (await needsSignIn()) {
        return res.status(401).json({ error: "Sign in with Google first.", signIn: "/auth/google" });
      }
      const data = await getData();
      if (!data.Channels.includes(row.Channel)) return res.status(400).json({ error: "Pick a channel" });
      const contact = data.Contacts.find(c => c.Contact_ID === row.Contact_ID);
      if (!contact) return res.status(400).json({ error: "Unknown contact" });
      await source.appendOutreach(row, contact);
      cache = null;
      res.status(201).json(row);
    } catch (err) {
      sendSourceError(res, err, "Could not save outreach");
    }
  });
});

// Return short JSON errors (e.g. malformed request body) instead of a stack trace.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 400 ? "Invalid request" : "Server error" });
});

app.listen(PORT, HOST, () => {
  console.log(`SRECRM running at http://localhost:${PORT} (data: ${source.mode})`);
});
