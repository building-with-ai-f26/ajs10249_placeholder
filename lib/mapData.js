// Turns raw sheet tabs (a header row followed by data rows) into the shape the
// frontend uses. Columns are always found by header name, never by position.
// Only the fields the app shows are passed on: emails, phones and notes stay in the sheet.

const REQUIRED = {
  Contacts: ["Contact_ID", "First_Name", "Last_Name", "Title", "Organization", "Owner", "Status", "Approval"],
  Organizations: ["Org_Name", "Sponsor_Status", "Current_Tier", "Outreach_Stage"],
  Outreach_Log: ["Date", "Contact_ID", "Channel", "Owner", "Summary"],
  Lists: ["Channel"],
};
const TABS = Object.keys(REQUIRED);

class SheetShapeError extends Error {}

function str(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function headerOf(values) {
  return (values[0] || []).map(str);
}

function rowsToObjects(tab, values = []) {
  const names = headerOf(values);
  const missing = REQUIRED[tab].filter(h => !names.includes(h));
  if (missing.length) {
    throw new SheetShapeError(`The "${tab}" tab is missing column(s): ${missing.join(", ")}`);
  }
  return values.slice(1).map(r => Object.fromEntries(names.map((h, i) => [h, r ? r[i] : ""])));
}

// Dates can arrive as a JS Date (Excel file), a serial number (Sheets API) or text.
// Everything becomes YYYY-MM-DD so history sorts correctly.
function toISODate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

// Only pass through real http(s) links, so a cell can never become a javascript: link.
function webUrl(v) {
  const s = str(v);
  if (!s) return "";
  const withScheme = /^https?:\/\//i.test(s) ? s : "https://" + s;
  try {
    const u = new URL(withScheme);
    return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? u.href : "";
  } catch { return ""; }
}

function linkedInUrl(v) {
  const u = webUrl(v);
  return /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(u) ? u : "";
}

function listColumn(objects, name) {
  return [...new Set(objects.map(o => str(o[name])).filter(Boolean))];
}

function buildData(tabs) {
  const Contacts = rowsToObjects("Contacts", tabs.Contacts)
    .filter(c => str(c.Contact_ID))
    .map(c => ({
      Contact_ID: str(c.Contact_ID),
      Name: [str(c.First_Name), str(c.Last_Name)].filter(Boolean).join(" "),
      Title: str(c.Title),
      Organization: str(c.Organization),
      Owner: str(c.Owner),
      Status: str(c.Status),
      Approval: str(c.Approval),
      Stern_Alum: str(c.Stern_Alum),
      LinkedIn: linkedInUrl(c.LinkedIn),
      // Emails are never sent to the browser. Only whether one exists, for the locked Email button.
      Has_Email: Boolean(str(c.Email)),
    }));

  const Organizations = rowsToObjects("Organizations", tabs.Organizations)
    .filter(o => str(o.Org_Name))
    .map(o => ({
      Org_Name: str(o.Org_Name),
      Sponsor_Status: str(o.Sponsor_Status),
      Current_Tier: str(o.Current_Tier),
      Outreach_Stage: str(o.Outreach_Stage),
      Type: str(o.Type),
      Website: webUrl(o.Website),
      HQ_City: str(o.HQ_City),
    }));

  const Outreach_Log = rowsToObjects("Outreach_Log", tabs.Outreach_Log)
    .filter(r => str(r.Contact_ID))
    .map(r => ({
      Date: toISODate(r.Date),
      Contact_ID: str(r.Contact_ID),
      Channel: str(r.Channel),
      Owner: str(r.Owner),
      Summary: str(r.Summary),
    }));

  const lists = rowsToObjects("Lists", tabs.Lists);
  return {
    Organizations,
    Contacts,
    Outreach_Log,
    Channels: listColumn(lists, "Channel"),
    Owners: listColumn(lists, "Sponsorship Team"),
    Org_Types: listColumn(lists, "Org_Type"),
  };
}

module.exports = { TABS, SheetShapeError, buildData, headerOf, str };
