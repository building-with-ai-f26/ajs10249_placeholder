const path = require("path");
const express = require("express");
const { SheetShapeError, ConflictError } = require("./lib/mapData");
const { createSampleSource } = require("./lib/sources/sample");
const { createXlsxSource } = require("./lib/sources/xlsx");
const { createGoogleSource } = require("./lib/sources/google");
const { createOrgProfiles } = require("./lib/orgProfile");

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
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  const msg = String((err && err.message) || "");
  if (/invalid_grant|No refresh token|invalid_token/i.test(msg) || (err && err.code === 401)) {
    return res.status(401).json({ error: "Google sign-in expired.", signIn: "/auth/google" });
  }
  if (err && err.code === 403) {
    return res.status(403).json({ error: "This Google account can't open or edit that part of the sheet. Check sharing and protected ranges." });
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

const profiles = createOrgProfiles({
  apiKey: process.env.OPENROUTER_API_KEY,
  cacheFile: process.env.ORG_PROFILE_CACHE_FILE,
});

// Firm profile from the web. Only works for firms that exist in the data,
// so the endpoint can't be used to send arbitrary prompts.
app.get("/api/org-profile", async (req, res) => {
  if (!profiles.enabled) return res.status(503).json({ error: "Add OPENROUTER_API_KEY to .env to look up firms." });
  try {
    const name = String(req.query.name || "");
    const org = (await getData()).Organizations.find(o => o.Org_Name === name);
    if (!org) return res.status(404).json({ error: "Unknown firm" });
    res.json(await profiles.get(org));
  } catch (err) {
    console.error("Firm profile failed:", err.message);
    res.status(502).json({ error: "Could not look up this firm right now." });
  }
});

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

// Assign a board member (or nobody) as Owner of a contact or firm.
app.post("/api/assign", (req, res) => {
  if (!source.canWrite) return res.status(403).json({ error: "Assigning is off while reading the Excel copy." });
  const body = req.body || {};
  const kind = body.kind === "firm" ? "firm" : body.kind === "contact" ? "contact" : "";
  const key = clean(body.key, 200);
  const owner = clean(body.owner, 80);
  // What the page showed before the change, so we don't overwrite an edit made in the sheet.
  const expected = typeof body.expected === "string" ? body.expected.trim() : undefined;
  if (!kind || !key) return res.status(400).json({ error: "Invalid request" });

  writeQueue = writeQueue.then(async () => {
    try {
      if (await needsSignIn()) return res.status(401).json({ error: "Sign in with Google first.", signIn: "/auth/google" });
      const data = await getData();
      if (owner && data.Owners.length && !data.Owners.includes(owner)) {
        return res.status(400).json({ error: "Pick someone from the team list" });
      }
      const record = kind === "firm"
        ? data.Organizations.find(o => o.Org_Name === key)
        : data.Contacts.find(c => c.Contact_ID === key);
      if (!record) return res.status(400).json({ error: "Unknown record" });
      const ids = [key, ...(record.Alt_IDs || [])]; // duplicate rows of the same person
      const previous = await source.setOwner(kind, key, owner, expected, ids);
      cache = null;
      res.json({ kind, key, owner, previous });
    } catch (err) {
      sendSourceError(res, err, "Could not save the assignment");
    }
  });
});

// Record that a board member knows a contact. Several people can know the same contact.
app.post("/api/relationship", (req, res) => {
  if (!source.canWrite) return res.status(403).json({ error: "Editing is off while reading the Excel copy." });
  const body = req.body || {};
  const rel = {
    Date: new Date().toLocaleDateString("en-CA"),
    Contact_ID: clean(body.Contact_ID, 20),
    Team_Member: clean(body.Team_Member, 80),
    Relationship: clean(body.Relationship, 40),
    Note: clean(body.Note, 200),
  };
  if (!rel.Team_Member) return res.status(400).json({ error: "Who knows them?" });

  writeQueue = writeQueue.then(async () => {
    try {
      if (await needsSignIn()) return res.status(401).json({ error: "Sign in with Google first.", signIn: "/auth/google" });
      const data = await getData();
      if (!data.Relationship_Types.includes(rel.Relationship)) return res.status(400).json({ error: "Pick a relationship type" });
      const contact = data.Contacts.find(c => c.Contact_ID === rel.Contact_ID);
      if (!contact) return res.status(400).json({ error: "Unknown contact" });
      await source.addRelationship(rel, contact);
      cache = null;
      res.status(201).json(rel);
    } catch (err) {
      sendSourceError(res, err, "Could not save the relationship");
    }
  });
});

// ---------- Tasks: assigned to-dos that become an outreach log entry when done ----------
const crypto = require("crypto");
const today = () => new Date().toLocaleDateString("en-CA");
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// Run a sheet write after earlier ones, with the usual sign-in check and error handling.
function queued(res, fallback, work) {
  writeQueue = writeQueue.then(async () => {
    try {
      if (await needsSignIn()) return res.status(401).json({ error: "Sign in with Google first.", signIn: "/auth/google" });
      await work(await getData());
    } catch (err) {
      sendSourceError(res, err, fallback);
    }
  });
}

function checkAssignee(data, name) {
  return name && (!data.Owners.length || data.Owners.includes(name));
}

// One task, or one per person when the request lists several contacts (e.g. a whole panel).
app.post("/api/tasks", (req, res) => {
  if (!source.canWrite) return res.status(403).json({ error: "Tasks are off while reading the Excel copy." });
  const body = req.body || {};
  const base = {
    Task: clean(body.Task, 300),
    Assigned_To: clean(body.Assigned_To, 80),
    Due: clean(body.Due, 10),
    Org_Name: clean(body.Org_Name, 200),
    Event_Name: clean(body.Event_Name, 200),
  };
  const ids = (Array.isArray(body.Contact_IDs) ? body.Contact_IDs : [body.Contact_ID])
    .map(id => clean(id, 20)).filter(Boolean).slice(0, 100);
  if (!base.Task) return res.status(400).json({ error: "Say what needs doing" });
  if (base.Due && !isDate(base.Due)) return res.status(400).json({ error: "Due date must be YYYY-MM-DD" });

  queued(res, "Could not save the task", async data => {
    if (!checkAssignee(data, base.Assigned_To)) return res.status(400).json({ error: "Assign it to someone on the team" });
    if (base.Org_Name && !data.Organizations.some(o => o.Org_Name === base.Org_Name)) return res.status(400).json({ error: "Unknown firm" });
    const contacts = ids.map(id => data.Contacts.find(c => c.Contact_ID === id || (c.Alt_IDs || []).includes(id)));
    if (contacts.some(c => !c)) return res.status(400).json({ error: "Unknown contact" });
    const people = contacts.length ? contacts : [null];
    const tasks = people.map(c => ({
      ...base,
      Task_ID: "T" + crypto.randomBytes(4).toString("hex"),
      Created: today(),
      Contact_ID: c ? c.Contact_ID : "",
      Contact: c ? c.Name : "",
      Org_Name: base.Org_Name || (c ? c.Organization : ""),
      Status: "Open",
      Done_Date: "",
      Done_Note: "",
    }));
    await source.addTasks(tasks);
    cache = null;
    res.status(201).json(tasks.map(({ Contact, ...t }) => t));
  });
});

app.post("/api/tasks/assign", (req, res) => {
  if (!source.canWrite) return res.status(403).json({ error: "Tasks are off while reading the Excel copy." });
  const body = req.body || {};
  const id = clean(body.Task_ID, 20), to = clean(body.Assigned_To, 80);
  const expected = typeof body.expected === "string" ? body.expected.trim() : undefined;
  queued(res, "Could not reassign the task", async data => {
    if (!checkAssignee(data, to)) return res.status(400).json({ error: "Assign it to someone on the team" });
    await source.updateTask(id, { Assigned_To: to }, cur => {
      if (expected !== undefined && cur.Assigned_To !== expected) {
        throw new ConflictError(`This task was reassigned to "${cur.Assigned_To || "nobody"}" in the sheet. Refresh and try again.`);
      }
    });
    cache = null;
    res.json({ Task_ID: id, Assigned_To: to });
  });
});

// Check a task off: mark it Done and, if it's about a person, log the outreach too.
app.post("/api/tasks/done", (req, res) => {
  if (!source.canWrite) return res.status(403).json({ error: "Tasks are off while reading the Excel copy." });
  const body = req.body || {};
  const id = clean(body.Task_ID, 20);
  const note = clean(body.Note, 300);
  const channel = clean(body.Channel, 40);
  const doneBy = clean(body.Done_By, 80);
  queued(res, "Could not complete the task", async data => {
    const task = data.Tasks.find(t => t.Task_ID === id);
    if (!task) return res.status(400).json({ error: "Unknown task" });
    if (task.Status === "Done") return res.status(409).json({ error: "Already done. Refresh the page." });
    const contact = task.Contact_ID && data.Contacts.find(c => c.Contact_ID === task.Contact_ID);
    if (contact && !data.Channels.includes(channel)) return res.status(400).json({ error: "Pick how you reached out" });

    // Log first: if marking done then fails, the task stays open and visible
    // rather than leaving a "done" task with no record of the outreach.
    let logged = null;
    if (contact) {
      logged = {
        Date: today(),
        Contact_ID: contact.Contact_ID,
        Channel: channel,
        Owner: doneBy || task.Assigned_To || "",
        Summary: (note ? `${task.Task}: ${note}` : task.Task).slice(0, 500),
      };
      await source.appendOutreach(logged, contact);
    }
    await source.updateTask(id, { Status: "Done", Done_Date: today(), Done_Note: note }, cur => {
      if (/^done$/i.test(cur.Status)) throw new ConflictError("Someone already checked this off. Refresh the page.");
    });
    cache = null;
    res.json({ Task_ID: id, Status: "Done", Done_Date: today(), Done_Note: note, logged });
  });
});

// Return short JSON errors (e.g. malformed request body) instead of a stack trace.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 400 ? "Invalid request" : "Server error" });
});

app.listen(PORT, HOST, () => {
  console.log(`SRECRM running at http://localhost:${PORT} (data: ${source.mode})`);
});
