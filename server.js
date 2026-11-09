const path = require("path");
const fs = require("fs/promises");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "sample", "sample.json");
const CHANNELS = ["Email", "Call", "LinkedIn", "In Person", "Other"];

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function readData() {
  return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
}

// Read the file on each request so edits to the sample data show up without a restart.
app.get("/api/data", async (req, res) => {
  try {
    res.json(await readData());
  } catch {
    res.status(500).json({ error: "Could not read sample data" });
  }
});

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Writes go one at a time so two quick submits can't overwrite each other.
let writeQueue = Promise.resolve();

app.post("/api/outreach", (req, res) => {
  const body = req.body || {};
  const row = {
    Date: clean(body.Date, 10),
    Contact_ID: clean(body.Contact_ID, 20),
    Channel: clean(body.Channel, 20),
    Owner: clean(body.Owner, 80),
    Summary: clean(body.Summary, 500),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.Date) || isNaN(Date.parse(row.Date))) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  }
  if (!CHANNELS.includes(row.Channel)) {
    return res.status(400).json({ error: "Pick a channel" });
  }
  if (!row.Owner) return res.status(400).json({ error: "Owner is required" });
  if (!row.Summary) return res.status(400).json({ error: "Summary is required" });

  writeQueue = writeQueue.then(async () => {
    try {
      const data = await readData();
      if (!data.Contacts.some(c => c.Contact_ID === row.Contact_ID)) {
        return res.status(400).json({ error: "Unknown contact" });
      }
      data.Outreach_Log.push(row);
      // Write to a temp file, then rename, so a crash mid-write can't corrupt the data.
      const tmp = DATA_FILE + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
      await fs.rename(tmp, DATA_FILE);
      res.status(201).json(row);
    } catch {
      res.status(500).json({ error: "Could not save outreach" });
    }
  });
});

// Return short JSON errors (e.g. malformed request body) instead of a stack trace.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.status === 400 ? "Invalid request" : "Server error" });
});

app.listen(PORT, () => {
  console.log(`SRECRM running at http://localhost:${PORT}`);
});
