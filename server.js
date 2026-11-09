const path = require("path");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data", "sample", "sample.json");

app.use(express.static(path.join(__dirname, "public")));

// Read the file on each request so edits to the sample data show up without a restart.
app.get("/api/data", (req, res) => {
  fs.readFile(DATA_FILE, "utf8", (err, text) => {
    if (err) return res.status(500).json({ error: "Could not read sample data" });
    try {
      res.json(JSON.parse(text));
    } catch {
      res.status(500).json({ error: "Sample data is not valid JSON" });
    }
  });
});

app.listen(PORT, () => {
  console.log(`SRECRM running at http://localhost:${PORT}`);
});
