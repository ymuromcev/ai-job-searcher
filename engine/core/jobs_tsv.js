// Shared jobs pool — data/jobs.tsv reader/writer.
//
// Serializes NormalizedJob (engine/modules/discovery/_types.js) into a
// flat TSV with header. `locations` is pipe-separated, `rawExtra` is JSON.
//
// Atomic save (tmp + rename) for the same reasons as companies.js.

const fs = require("fs");
const path = require("path");

const HEADER = [
  "source",
  "slug",
  "jobId",
  "companyName",
  "title",
  "url",
  "locations",
  "team",
  "postedAt",
  "discoveredAt",
  "rawExtra",
];

function escapeField(v) {
  if (v === undefined || v === null) return "";
  return String(v).replace(/[\t\r\n]/g, " ");
}

function jobToRow(job, discoveredAt) {
  return [
    escapeField(job.source),
    escapeField(job.slug),
    escapeField(job.jobId),
    escapeField(job.companyName),
    escapeField(job.title),
    escapeField(job.url),
    Array.isArray(job.locations) ? job.locations.map(escapeField).join("|") : "",
    escapeField(job.team || ""),
    escapeField(job.postedAt || ""),
    escapeField(discoveredAt || job.discoveredAt || ""),
    job.rawExtra ? JSON.stringify(job.rawExtra) : "{}",
  ].join("\t");
}

function rowToJob(parts, lineNo) {
  if (parts.length < HEADER.length) {
    throw new Error(`jobs.tsv line ${lineNo}: expected ${HEADER.length} cols, got ${parts.length}`);
  }
  const [source, slug, jobId, companyName, title, url, locations, team, postedAt, discoveredAt, rawExtra] =
    parts;
  let extra = {};
  if (rawExtra && rawExtra !== "{}") {
    try {
      extra = JSON.parse(rawExtra);
    } catch (err) {
      throw new Error(`jobs.tsv line ${lineNo}: invalid rawExtra JSON: ${err.message}`);
    }
  }
  return {
    source,
    slug,
    jobId,
    companyName,
    title,
    url,
    locations: locations ? locations.split("|").filter(Boolean) : [],
    team: team || null,
    postedAt: postedAt || null,
    discoveredAt: discoveredAt || null,
    rawExtra: extra,
  };
}

function load(filePath) {
  if (!fs.existsSync(filePath)) return { jobs: [], path: filePath };
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return { jobs: [], path: filePath };
  const headerCols = lines[0].split("\t").map((s) => s.trim());
  if (
    headerCols.length !== HEADER.length ||
    !headerCols.every((c, i) => c === HEADER[i])
  ) {
    throw new Error(
      `jobs.tsv header mismatch: expected [${HEADER.join(", ")}], got [${headerCols.join(", ")}]`
    );
  }
  const jobs = [];
  for (let i = 1; i < lines.length; i += 1) {
    jobs.push(rowToJob(lines[i].split("\t"), i + 1));
  }
  return { jobs, path: filePath };
}

function save(filePath, jobs, { now = new Date().toISOString() } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [HEADER.join("\t")];
  for (const j of jobs) {
    lines.push(jobToRow(j, j.discoveredAt || now));
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.renameSync(tmp, filePath);
  return { path: filePath, count: jobs.length };
}

module.exports = { load, save, jobToRow, rowToJob, HEADER };
