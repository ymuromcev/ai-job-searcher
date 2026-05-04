// Pure dedup: removes duplicate jobs from a list, preserving first occurrence.
// Primary key = (source, jobId) — exact dedup within a single platform.
// Secondary key = (normalizedCompany, normalizedTitle) — fuzzy dedup across
// platforms. Catches the case where the same role is posted on both Greenhouse
// and Lever for the same company; without it, both rows enter the pipeline.

// Some adapters emit jobIds with an ATS-prefix (e.g. "gh:7769924", "lever:abcd"),
// others emit the raw id ("7769924"). Strip the prefix so two scans of the same
// posting via different adapter versions collide on the same key.
function normalizeJobId(id) {
  const s = String(id || "").trim().toLowerCase();
  const m = s.match(/^(gh|ashby|lever|workday|smart|sr):(.+)$/);
  return m ? m[2] : s;
}

function jobKey(job) {
  const source = String(job.source || "").toLowerCase().trim();
  const id = normalizeJobId(job.jobId);
  return `${source}:${id}`;
}

function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[,.]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(inc|llc|ltd|corp|co)\.?$/i, "")
    .trim();
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[,.()/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyKey(job) {
  // Adapters emit `companyName`; tests + some legacy callers may use `company`.
  const company = normalizeCompanyName(job.companyName || job.company);
  const title = normalizeTitle(job.title);
  if (!company || !title) return null;
  return `${company}::${title}`;
}

function dedupeJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error("jobs must be an array");
  const seenExact = new Map();
  const seenFuzzy = new Set();
  const out = [];
  for (const job of jobs) {
    const key = jobKey(job);
    if (!key || key === ":") continue; // skip malformed
    if (seenExact.has(key)) continue;
    const fuzzy = fuzzyKey(job);
    if (fuzzy && seenFuzzy.has(fuzzy)) continue;
    seenExact.set(key, job);
    if (fuzzy) seenFuzzy.add(fuzzy);
    out.push(job);
  }
  return out;
}

function dedupeAgainst(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new Error("both arguments must be arrays");
  }
  const existingKeys = new Set(existing.map(jobKey));
  const existingFuzzy = new Set();
  for (const job of existing) {
    const fuzzy = fuzzyKey(job);
    if (fuzzy) existingFuzzy.add(fuzzy);
  }
  const fresh = [];
  for (const job of incoming) {
    const key = jobKey(job);
    if (existingKeys.has(key)) continue;
    const fuzzy = fuzzyKey(job);
    if (fuzzy && existingFuzzy.has(fuzzy)) continue;
    fresh.push(job);
    existingKeys.add(key);
    if (fuzzy) existingFuzzy.add(fuzzy);
  }
  return fresh;
}

module.exports = { jobKey, normalizeJobId, normalizeCompanyName, normalizeTitle, fuzzyKey, dedupeJobs, dedupeAgainst };
