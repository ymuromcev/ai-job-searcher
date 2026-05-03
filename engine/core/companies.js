// Shared companies pool loader/writer.
//
// File format (TSV, header row required):
//   name <TAB> ats_source <TAB> ats_slug <TAB> extra_json
// extra_json is optional; when present, must be a JSON object holding
// adapter-specific fields (e.g. workday `dc`/`site`, indeed `ingestFile`).
//
// One row per (ats_source, ats_slug) combination — the same legal entity may
// have multiple rows if it lives on multiple platforms (see RFC §Sharing).
//
// Writes go through a tmp file + atomic rename to avoid partial-write races
// when multiple scans land at the same time.

const fs = require("fs");
const path = require("path");

// 5-column schema (RFC 010 part B):
//   name <TAB> ats_source <TAB> ats_slug <TAB> extra_json <TAB> profile
// `profile` is optional. Allowed values:
//   ""      — public / shared across all profiles (legacy 4-col rows).
//   "both"  — explicit alias for "" (public).
//   "<id>"  — visible only to that profile (e.g. "jared", "lilia").
// Multi-profile rows: comma-separated ids ("jared,lilia") — each id matches.
// Backward-compat: 4-col files load fine, every row becomes profile="".
const HEADER = ["name", "ats_source", "ats_slug", "extra_json", "profile"];

function escapeField(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\t\r\n]/g, " ");
}

function rowKey(name, source, slug) {
  return `${String(source).toLowerCase()}\t${String(slug)}`;
}

function parseExtra(raw) {
  if (!raw || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("extra_json must be a JSON object");
    }
    return parsed;
  } catch (err) {
    throw new Error(`invalid extra_json: ${err.message}`);
  }
}

function parseProfile(raw) {
  // Empty + "both" both mean "visible to every profile". Multi-id values
  // are comma-separated and trimmed.
  const v = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!v || v === "both") return "";
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

function parseLine(line, lineNo) {
  const parts = line.split("\t");
  if (parts.length < 3) {
    throw new Error(`line ${lineNo}: expected ≥3 tab-separated fields, got ${parts.length}`);
  }
  const [name, source, slug, extraRaw, profileRaw] = parts;
  if (!name || !source || !slug) {
    throw new Error(`line ${lineNo}: name/ats_source/ats_slug are all required`);
  }
  const extra = parseExtra(extraRaw);
  const profile = parseProfile(profileRaw);
  return {
    name: name.trim(),
    source: source.trim().toLowerCase(),
    slug: slug.trim(),
    extra,
    profile,
  };
}

function load(filePath) {
  if (!fs.existsSync(filePath)) {
    return { rows: [], path: filePath };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { rows: [], path: filePath };
  const headerCols = lines[0].split("\t").map((s) => s.trim());
  const expectedFirst = HEADER.slice(0, 3);
  if (!expectedFirst.every((c, i) => headerCols[i] === c)) {
    throw new Error(
      `header mismatch in ${filePath}: expected [${HEADER.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }
  const seen = new Set();
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseLine(lines[i], i + 1);
    const key = rowKey(row.name, row.source, row.slug);
    if (seen.has(key)) continue; // silent dedupe — keeps file forgiving
    seen.add(key);
    rows.push(row);
  }
  return { rows, path: filePath };
}

function serialize(rows) {
  const out = [HEADER.join("\t")];
  for (const r of rows) {
    const extra = r.extra ? JSON.stringify(r.extra) : "";
    const profile = r.profile ? String(r.profile) : "";
    out.push(
      [
        escapeField(r.name),
        escapeField(r.source).toLowerCase(),
        escapeField(r.slug),
        extra,
        escapeField(profile),
      ].join("\t")
    );
  }
  return out.join("\n") + "\n";
}

function save(filePath, rows) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic replace: write to a sibling tmp path then rename. Same-filesystem
  // rename is atomic on POSIX and works as a replacing rename on Windows.
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, serialize(rows));
  fs.renameSync(tmp, filePath);
  return { path: filePath, count: rows.length };
}

function merge(existing, incoming) {
  // Idempotent merge keyed by (source, slug). Incoming wins on conflict so
  // updated metadata (extra_json, name fixes) propagates.
  const byKey = new Map();
  for (const r of existing) byKey.set(rowKey(r.name, r.source, r.slug), r);
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const key = rowKey(r.name, r.source, r.slug);
    if (byKey.has(key)) {
      const prev = byKey.get(key);
      if (prev.name !== r.name || JSON.stringify(prev.extra) !== JSON.stringify(r.extra)) {
        byKey.set(key, r);
        updated += 1;
      }
    } else {
      byKey.set(key, r);
      added += 1;
    }
  }
  return { rows: Array.from(byKey.values()), added, updated };
}

function groupBySource(rows) {
  const out = {};
  for (const r of rows) {
    if (!out[r.source]) out[r.source] = [];
    const target = { name: r.name, slug: r.slug };
    if (r.extra) Object.assign(target, r.extra);
    if (r.profile) target.profile = r.profile;
    out[r.source].push(target);
  }
  return out;
}

// Returns rows visible to `profileId`. A row is visible when:
//   - row.profile is empty / unset / "both"  → public, every profile sees it
//   - row.profile === profileId               → exclusive to that profile
//   - row.profile is comma-list containing profileId
// Profiles unknown to the row are filtered out — this is the cross-profile
// isolation gate (replaces the brittle blacklist-on-Jared approach).
function rowVisibleToProfile(row, profileId) {
  const p = row && row.profile ? String(row.profile).trim().toLowerCase() : "";
  if (!p || p === "both") return true;
  const ids = p.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(profileId || "").toLowerCase());
}

function filterByProfile(rows, profileId) {
  if (!profileId) return rows.slice();
  return rows.filter((r) => rowVisibleToProfile(r, profileId));
}

module.exports = {
  load,
  save,
  serialize,
  merge,
  groupBySource,
  filterByProfile,
  rowVisibleToProfile,
  HEADER,
};
