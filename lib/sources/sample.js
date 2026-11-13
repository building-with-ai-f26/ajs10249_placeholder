// Made-up sample data in data/sample/sample.json. The default mode, safe for screenshots.
const path = require("path");
const fs = require("fs/promises");
const { RELATIONSHIP_TYPES, ConflictError } = require("../mapData");

const DATA_FILE = path.join(__dirname, "..", "..", "data", "sample", "sample.json");
const CHANNELS = ["Email", "Call", "LinkedIn", "In Person", "Other"];

async function readFile() {
  return JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
}

// Write to a temp file, then rename, so a crash mid-write can't corrupt the data.
async function writeFile(data) {
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  // OneDrive/antivirus can hold the file for a moment after a write; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(tmp, DATA_FILE); } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EBUSY" || attempt >= 5) throw err;
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

function createSampleSource() {
  return {
    mode: "sample",
    canWrite: true,
    cacheMs: 0, // re-read each time so edits to the file show without a restart
    async read() {
      const data = await readFile();
      const owners = [...new Set(data.Contacts.map(c => c.Owner).filter(Boolean))].sort();
      return {
        Channels: CHANNELS, Owners: owners, Relationships: [], Relationship_Types: RELATIONSHIP_TYPES,
        Tasks: [], Panels: data.Contacts.length >= 3
          ? [{ Event_Name: "Sample Panel Night", Date: "2026-10-20", Contact_IDs: data.Contacts.slice(0, 3).map(c => c.Contact_ID) }]
          : [],
        ...data,
        Organizations: data.Organizations.map(o => ({ Owner: "", ...o })),
      };
    },
    async appendOutreach(row) {
      const data = await readFile();
      data.Outreach_Log.push(row);
      await writeFile(data);
    },
    async setOwner(kind, key, owner, expected) {
      const data = await readFile();
      const record = kind === "firm"
        ? data.Organizations.find(o => o.Org_Name === key)
        : data.Contacts.find(c => c.Contact_ID === key);
      if (!record) throw new ConflictError("That record is no longer in the data. Refresh the page.");
      const previous = record.Owner || "";
      if (expected !== undefined && previous !== expected) throw new ConflictError("The owner changed. Refresh and try again.");
      record.Owner = owner;
      await writeFile(data);
      return previous;
    },
    async addTasks(tasks) {
      const data = await readFile();
      (data.Tasks = data.Tasks || []).push(...tasks);
      await writeFile(data);
    },
    async updateTask(taskId, fields, check) {
      const data = await readFile();
      const task = (data.Tasks || []).find(t => t.Task_ID === taskId);
      if (!task) throw new ConflictError("That task is no longer there. Refresh the page.");
      const current = { ...task };
      if (check) check(current);
      Object.assign(task, fields);
      await writeFile(data);
      return current;
    },
    async addRelationship(rel) {
      const data = await readFile();
      (data.Relationships = data.Relationships || []).push(rel);
      await writeFile(data);
    },
  };
}

module.exports = { createSampleSource };
