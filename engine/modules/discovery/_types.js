// Normalized job record — the contract every discovery adapter produces.
// Shared pool `data/jobs.tsv` and dedup key (source, jobId) rely on this shape.
//
// Fields:
//   source      string   adapter id (greenhouse, lever, ...). Matches `source` exported by the adapter.
//   slug        string   ats-specific company identifier (e.g. greenhouse board token).
//   companyName string   human-readable company name.
//   jobId       string   platform-native job id. MUST be non-empty; dedup key.
//   title       string   role title.
//   url         string   apply/view url.
//   locations   string[] zero or more location strings as reported by the source.
//   team        string?  optional department / team label.
//   postedAt    string?  ISO-8601 date (YYYY-MM-DD) if available; otherwise null.
//   rawExtra    object   adapter-specific payload (never read by core).

const REQUIRED = ["source", "slug", "companyName", "jobId", "title", "url"];

function assertJob(job) {
  if (!job || typeof job !== "object") {
    throw new Error("job must be an object");
  }
  for (const key of REQUIRED) {
    if (typeof job[key] !== "string" || job[key].length === 0) {
      throw new Error(`job.${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(job.locations)) {
    throw new Error("job.locations must be an array");
  }
  for (const loc of job.locations) {
    if (typeof loc !== "string") {
      throw new Error("job.locations items must be strings");
    }
  }
  if (job.team !== undefined && job.team !== null && typeof job.team !== "string") {
    throw new Error("job.team must be a string or null");
  }
  if (job.postedAt !== undefined && job.postedAt !== null) {
    if (typeof job.postedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(job.postedAt)) {
      throw new Error("job.postedAt must be ISO YYYY-MM-DD or null");
    }
  }
  if (
    job.rawExtra !== undefined &&
    (job.rawExtra === null || typeof job.rawExtra !== "object" || Array.isArray(job.rawExtra))
  ) {
    throw new Error("job.rawExtra must be a plain object");
  }
}

function isValidJob(job) {
  try {
    assertJob(job);
    return true;
  } catch {
    return false;
  }
}

module.exports = { assertJob, isValidJob, REQUIRED };
