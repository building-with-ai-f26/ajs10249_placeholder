// "What is this firm and what does it do?" filled in from the web.
// Sends only public firm info (name, type, city, website) to OpenRouter, never contact data.
// Answers are cached in a JSON file outside the repo so each firm is looked up once.
const fs = require("fs/promises");

const MODEL = process.env.OPENROUTER_PROFILE_MODEL || "anthropic/claude-haiku-5.5";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function createOrgProfiles({ apiKey, cacheFile }) {
  let cache = null;
  const inFlight = new Map();

  async function loadCache() {
    if (cache) return cache;
    try { cache = JSON.parse(await fs.readFile(cacheFile, "utf8")); } catch { cache = {}; }
    return cache;
  }

  async function saveCache() {
    if (!cacheFile) return;
    const tmp = cacheFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, cacheFile);
  }

  async function lookUp(org) {
    const hints = [org.Type && `type: ${org.Type}`, org.HQ_City && `HQ: ${org.HQ_City}`, org.Website && `website: ${org.Website}`]
      .filter(Boolean).join("; ");
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "SRECRM" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        reasoning: { effort: "low" },
        plugins: [{ id: "web", max_results: 4 }],
        messages: [
          {
            role: "system",
            content:
              "You write short, factual company profiles for a student real estate club's sponsorship team. " +
              "Use the web results. If you cannot confidently identify the company, say so instead of guessing. " +
              'Reply with JSON only: {"found": boolean, "summary": "1-2 sentences: what the firm is", ' +
              '"what_they_do": ["2-4 short bullets: business lines, property types, markets"], ' +
              '"hq": "city or empty", "website": "url or empty", "size": "e.g. AUM, employees or portfolio size if stated, else empty"}',
          },
          { role: "user", content: `Real estate firm: "${org.Org_Name}"${hints ? ` (${hints})` : ""}` },
        ],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || `OpenRouter error ${res.status}`);

    const message = (json.choices && json.choices[0] && json.choices[0].message) || {};
    const text = String(message.content || "");
    const match = text.match(/\{[\s\S]*\}/);
    let parsed;
    try { parsed = JSON.parse(match ? match[0] : text); } catch {
      // Cut off or not JSON: treat as "not confirmed" rather than failing the page.
      parsed = { found: false, summary: "", what_they_do: [] };
    }

    const sources = (message.annotations || [])
      .filter(a => a.type === "url_citation" && a.url_citation && /^https?:\/\//.test(a.url_citation.url))
      .map(a => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url }))
      .filter((s, i, all) => all.findIndex(x => x.url === s.url) === i)
      .slice(0, 4);

    return {
      found: parsed.found !== false && Boolean(parsed.summary),
      summary: String(parsed.summary || ""),
      what_they_do: Array.isArray(parsed.what_they_do) ? parsed.what_they_do.map(String).slice(0, 4) : [],
      hq: String(parsed.hq || ""),
      website: /^https?:\/\//.test(parsed.website || "") ? parsed.website : "",
      size: String(parsed.size || ""),
      sources,
      model: MODEL,
      fetched: new Date().toISOString().slice(0, 10),
    };
  }

  return {
    enabled: Boolean(apiKey),

    async get(org, { refresh = false } = {}) {
      const store = await loadCache();
      const key = org.Org_Name.toLowerCase();
      if (!refresh && store[key]) return store[key];
      // Two people opening the same firm at once share one lookup.
      if (!inFlight.has(key)) {
        inFlight.set(key, lookUp(org)
          .then(async profile => { store[key] = profile; await saveCache(); return profile; })
          .finally(() => inFlight.delete(key)));
      }
      return inFlight.get(key);
    },
  };
}

module.exports = { createOrgProfiles };
