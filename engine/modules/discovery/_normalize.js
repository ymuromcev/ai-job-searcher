// Small pure helpers used by multiple adapters.

function sanitizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeLocation(value) {
  // Reject non-primitive inputs early — some ATS APIs return objects/arrays
  // and `String({})` would produce "[object Object]" and silently pollute data.
  if (value !== null && typeof value === "object") return "";
  const cleaned = sanitizeText(value);
  if (!cleaned) return "";
  if (/^remote\b/i.test(cleaned)) return "Remote";
  return cleaned;
}

function dedupeLocations(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of arr || []) {
    const norm = normalizeLocation(raw);
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function safeJoinUrl(base, pathname) {
  if (!base) return pathname || "";
  if (!pathname) return base;
  if (/^https?:\/\//i.test(pathname)) return pathname;
  const b = base.replace(/\/+$/, "");
  const p = String(pathname).replace(/^\/+/, "");
  return `${b}/${p}`;
}

module.exports = { sanitizeText, parseIsoDate, normalizeLocation, dedupeLocations, safeJoinUrl };
