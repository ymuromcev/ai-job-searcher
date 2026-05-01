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

  if (typeof value === "string") {
    // ISO YYYY-MM-DD prefix (date-only or full ISO datetime): extract directly.
    // Avoids local-timezone drift when the Date constructor would otherwise
    // re-interpret the value through host TZ before .toISOString() projects to UTC.
    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const [, y, mo, d] = isoMatch;
      const yi = +y;
      const moi = +mo - 1;
      const di = +d;
      const tmp = new Date(Date.UTC(yi, moi, di));
      if (
        tmp.getUTCFullYear() === yi &&
        tmp.getUTCMonth() === moi &&
        tmp.getUTCDate() === di
      ) {
        return `${y}-${mo}-${d}`;
      }
      return null;
    }

    // Bare date string with no time component (e.g. "April 15, 2026"):
    // Date parses these as LOCAL midnight, so projecting through UTC drifts a day
    // on any +offset host. Read the local date components instead — the user
    // wrote a date, return that date.
    if (!/[T:]/.test(value)) {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  // Numbers (unix timestamps) or strings with a time component: UTC projection
  // is well-defined and stable across hosts.
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
