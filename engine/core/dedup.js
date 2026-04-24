// Pure dedup: removes duplicate jobs from a list, preserving first occurrence.
// Dedup key = (source, jobId). Company name normalization is a separate helper.

function jobKey(job) {
  const source = String(job.source || "").toLowerCase().trim();
  const id = String(job.jobId || "").trim();
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

function dedupeJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error("jobs must be an array");
  const seen = new Map();
  for (const job of jobs) {
    const key = jobKey(job);
    if (!key || key === ":") continue; // skip malformed
    if (!seen.has(key)) seen.set(key, job);
  }
  return Array.from(seen.values());
}

function dedupeAgainst(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new Error("both arguments must be arrays");
  }
  const existingKeys = new Set(existing.map(jobKey));
  const fresh = [];
  for (const job of incoming) {
    const key = jobKey(job);
    if (!existingKeys.has(key)) {
      fresh.push(job);
      existingKeys.add(key);
    }
  }
  return fresh;
}

module.exports = { jobKey, normalizeCompanyName, dedupeJobs, dedupeAgainst };
