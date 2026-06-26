// RFC 062 — relokant-sweep → Notion Companies upsert (pure core).
//
// Given parsed relokant target rows and a known-set built from the three
// sources that feed the Companies DB (existing Notion pages, data/companies.tsv,
// the relokant ledgers), decide for each candidate whether to CREATE a new
// Notion page, FILL empty fields on an existing page, or SKIP it.
//
// Pure: no Notion client, no fs, no network. The command shell does the I/O,
// hands this module plain in-memory data, and turns the returned field
// descriptors into Notion property objects.
//
// Dedup is on code (two keys): a candidate matches an existing company if
// EITHER its normalized domain OR its normalized name is already known.
// Fill-gaps: on an existing Notion page, only empty mapped fields are written;
// a non-empty value is never overwritten and nothing is deleted. `Tier` is
// never written (it is the operator's pipeline judgement).

const { normalizeName, normalizeDomain } = require("./company_keys.js");

// Build the full website URL stored in the `Website` property from the TSV
// `website` column ("lokalise.com" -> "https://lokalise.com"; an already-
// schemed value is kept as-is).
function websiteUrl(website) {
  const s = (website || "").trim();
  if (!s) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

function whyInterested(row) {
  // Strip a trailing period so the formatter's own "." doesn't double up
  // ("US SaaS." -> "US SaaS" -> "US SaaS.").
  const ru = (row.ru_signal || "").trim().replace(/\.+$/, "");
  const market = (row.market || "").trim().replace(/\.+$/, "");
  if (!ru && !market) return "";
  const parts = [];
  if (ru) parts.push(`CIS-edge: ${ru}.`);
  if (market) parts.push(`${market}.`);
  return parts.join(" ").trim();
}

function notesText(row) {
  const bits = ["Relokant sweet-zone (US-HQ)."];
  if ((row.contact || "").trim()) bits.push(`Contact: ${row.contact.trim()}.`);
  if ((row.us_viability || "").trim()) bits.push(`US-viability: ${row.us_viability.trim()}.`);
  if ((row.ats || "").trim()) bits.push(`ATS: ${row.ats.trim()}.`);
  if ((row.notes || "").trim()) bits.push(row.notes.trim());
  return bits.join(" ").trim();
}

// Declarative field map. `role`:
//   "key"  — the title; create-only, never filled (it IS the dedup key).
//   "fill" — written on create AND back-filled on an existing page if empty.
const FIELD_SPECS = [
  { field: "Name", type: "title", role: "key", from: (r) => (r.name || "").trim() },
  { field: "Website", type: "url", role: "fill", from: (r) => websiteUrl(r.website) },
  { field: "Careers URL", type: "url", role: "fill", from: (r) => (r.open_roles_url || "").trim() },
  { field: "Why Interested", type: "rich_text", role: "fill", from: (r) => whyInterested(r) },
  { field: "Notes", type: "rich_text", role: "fill", from: (r) => notesText(r) },
  { field: "Outbound Status", type: "select", role: "fill", from: () => "Not started" },
];

function isEmpty(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function candidateKeys(row) {
  return {
    nameKey: normalizeName(row.name || ""),
    domainKey: normalizeDomain(row.website || ""),
  };
}

// Build the known-set index from the three sources. Notion entries carry the
// page id + current property values (for fill-gaps); tsv/ledger entries only
// mark presence. Notion entries win when a key appears in more than one source.
//
//   notionPages: [{ pageId, name, website, values: { <field>: <string> } }]
//   tsvNames:    [ "Acme", ... ]   (data/companies.tsv — name column only)
//   ledgerNames: [ "Acme", ... ]   (relokant targets + rejects)
function buildKnownIndex({ notionPages = [], tsvNames = [], ledgerNames = [] } = {}) {
  const byName = new Map();
  const byDomain = new Map();

  const addPresence = (name) => {
    const key = normalizeName(name);
    if (key && !byName.has(key)) byName.set(key, { inNotion: false });
  };
  // Non-Notion sources first so a later Notion entry overwrites the bare
  // presence marker with a real page id.
  for (const n of tsvNames) addPresence(n);
  for (const n of ledgerNames) addPresence(n);

  for (const p of notionPages) {
    const entry = { inNotion: true, pageId: p.pageId, values: p.values || {} };
    const nameKey = normalizeName(p.name || "");
    const domainKey = normalizeDomain(p.website || "");
    if (nameKey) byName.set(nameKey, entry);
    if (domainKey) byDomain.set(domainKey, entry);
  }
  return { byName, byDomain };
}

// Field descriptors for a brand-new page: every spec whose value is non-empty
// (Name always present — a row without a name is rejected upstream).
function createProps(row) {
  const props = [];
  for (const spec of FIELD_SPECS) {
    const value = spec.from(row);
    if (!isEmpty(value)) props.push({ field: spec.field, type: spec.type, value });
  }
  return props;
}

// Field descriptors to back-fill on an existing page: a "fill"-role spec whose
// current page value is empty AND whose new value is non-empty.
function fillProps(row, pageValues) {
  const props = [];
  for (const spec of FIELD_SPECS) {
    if (spec.role !== "fill") continue;
    if (!isEmpty(pageValues[spec.field])) continue; // never overwrite
    const value = spec.from(row);
    if (isEmpty(value)) continue; // nothing to add
    props.push({ field: spec.field, type: spec.type, value });
  }
  return props;
}

// Partition candidate rows into { creates, fills, skips }.
function planUpsert({ rows = [], known = { byName: new Map(), byDomain: new Map() } } = {}) {
  const creates = [];
  const fills = [];
  const skips = [];
  const seenNames = new Set();
  const seenDomains = new Set();

  for (const row of rows) {
    const name = (row.name || "").trim();
    const { nameKey, domainKey } = candidateKeys(row);
    if (!nameKey) {
      skips.push({ name, reason: "no-name" });
      continue;
    }
    // In-batch collapse: same company listed twice within one run.
    if (seenNames.has(nameKey) || (domainKey && seenDomains.has(domainKey))) {
      skips.push({ name, reason: "in-batch-dup" });
      continue;
    }
    seenNames.add(nameKey);
    if (domainKey) seenDomains.add(domainKey);

    const match = (domainKey && known.byDomain.get(domainKey)) || known.byName.get(nameKey) || null;

    if (match && match.inNotion) {
      const props = fillProps(row, match.values || {});
      if (props.length) {
        fills.push({ name, pageId: match.pageId, props });
      } else {
        skips.push({ name, reason: "already-complete" });
      }
    } else if (match) {
      // Known via data/companies.tsv or the ledgers but no Notion page yet —
      // treat as known and do NOT create a duplicate (two-way dedup).
      skips.push({ name, reason: "known-non-notion" });
    } else {
      creates.push({ name, nameKey, domainKey, props: createProps(row) });
    }
  }

  return { creates, fills, skips };
}

module.exports = {
  planUpsert,
  buildKnownIndex,
  createProps,
  fillProps,
  candidateKeys,
  websiteUrl,
  whyInterested,
  notesText,
  FIELD_SPECS,
};
