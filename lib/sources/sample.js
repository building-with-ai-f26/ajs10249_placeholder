// Made-up sample data in data/sample/sample.json. The default mode, safe for screenshots.
const path = require("path");
const fs = require("fs/promises");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "sample", "sample.json");
const CHANNELS = ["Email", "Call", "LinkedIn", "In Person", "Other"];

async function readFile() {
  return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
}

function createSampleSource() {
  return {
    mode: "sample",
    canWrite: true,
    cacheMs: 0, // re-read each time so edits to the file show without a restart
    async read() {
      const data = await readFile();
      return { Channels: CHANNELS, Owners: [], ...data };
    },
    async appendOutreach(row) {
      const data = await readFile();
      data.Outreach_Log.push(row);
      // Write to a temp file, then rename, so a crash mid-write can't corrupt the data.
      const tmp = DATA_FILE + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
      await fs.rename(tmp, DATA_FILE);
    },
  };
}

module.exports = { createSampleSource };
