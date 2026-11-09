# SRECRM: a sponsorship CRM for the NYU Stern Real Estate Club board

One job: let a board member find a firm or contact, see the history, and log an outreach in under a minute.

## Rules
- Small changes. Commit after each working step with a clear message.
- Never commit secrets. Keys, the service-account JSON, and the Google Sheet ID live in .env (listed in .gitignore).
- Never commit real contact data. Sheet contents (names, emails, phone numbers, alumni rows) stay in the sheet. The repo holds sample data only, in data/sample/.
- The Google Sheet is the source of truth. The app reads it via a service account and writes only to log tabs (Outreach_Log, Event_Attendance). Core fields are edited in the sheet by design.
- Read sheet columns by header name, never by position.
- Plain stack: Node + Express backend, plain HTML/CSS/JS frontend, no framework, no build step, unless I say otherwise.
- Before saying "done", run the app and tell me exactly how you verified it.
- Keep docs/index.html (Product Page = PRD + build log) up to date.
- If a task gets big or confusing, stop and propose a smaller slice.

## Weekly build (due Monday noon)
- Add a build-log entry to docs/index.html: what shipped, what broke, what it cost (tokens, API, hosting, hours), what is next.

## Prior work
- docs/prior-work/ holds the design summary of an earlier Google Apps Script version. Reuse its data model and feature decisions; do not reuse its architecture.
