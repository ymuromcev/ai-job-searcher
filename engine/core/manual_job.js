// engine/core/manual_job.js
//
// Pure helpers for `add` — manual job entry (RFC 063 / BL-208).
//
// Vacancies that arrive outside the ATS scan (referrals, newsletters,
// recruiter email, direct site applications) are entered by hand. These
// helpers build the TSV row and the Notion payload; no filesystem, no
// network, no env. The command (engine/commands/add.js) owns side effects.
//
// Manual rows deliberately skip `Inbox`: that status means "discovered, not
// yet evaluated by prepare" (RFC 014), which a hand-entered row never is —
// the operator asserts its status because they already know it.

const { EXPECTED_STATUS_OPTIONS } = require("./notion_status_options.js");
const { formatSalaryDisplay } = require("./notion_job_page.js");

// Seniority prefixes are stripped for duplicate *comparison* only — never
// from the stored title. "Senior PM, Pricing" and "PM, Pricing" at the same
// company are almost certainly the same posting re-entered.
const SENIORITY_PREFIXES = ["senior", "sr", "staff", "lead", "principal", "junior", "jr"];

// ---------- Slugs and keys ----------

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// `manual:<company>_<title>_<YYYY-MM-DD>`. The date suffix keeps two genuinely
// different postings at the same company distinguishable; near-duplicate entry
// on a different day is caught by findDuplicates, not by the key.
function makeManualKey({ company, title, date }) {
  const c = slugify(company);
  const t = slugify(title);
  if (!c) throw new Error("company is required");
  if (!t) throw new Error("title is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    throw new Error(`date must be YYYY-MM-DD, got: ${date}`);
  }
  return `manual:${c}_${t}_${date}`;
}

// ---------- Input parsing / validation ----------

// "140000-185000" → {min, max}; "140000" → {min, max: null}; "" → both null.
function parseSalaryRange(input) {
  const raw = String(input || "").trim();
  if (!raw) return { min: null, max: null };
  const m = raw.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) {
    throw new Error(`--salary must be "MIN" or "MIN-MAX" in whole dollars, got: ${input}`);
  }
  const min = Number(m[1]);
  const max = m[2] === undefined ? null : Number(m[2]);
  if (max !== null && max < min) {
    throw new Error(`--salary max (${max}) is below min (${min})`);
  }
  return { min, max };
}

// `Inbox` is rejected explicitly: it is TSV-only by RFC 014 and would fail
// Notion validation anyway. The error names the reason rather than just
// listing valid values.
function validateStatus(status) {
  const s = String(status || "").trim();
  if (!s) throw new Error(`--status is required (one of: ${EXPECTED_STATUS_OPTIONS.join(", ")})`);
  if (s === "Inbox") {
    throw new Error(
      "status Inbox is TSV-only (RFC 014) and never reaches Notion; a manual row asserts a real status"
    );
  }
  if (!EXPECTED_STATUS_OPTIONS.includes(s)) {
    throw new Error(`unknown status: ${s} (one of: ${EXPECTED_STATUS_OPTIONS.join(", ")})`);
  }
  return s;
}

function validateDate(value, flag) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${flag} must be YYYY-MM-DD, got: ${value}`);
  return v;
}

const VALID_TIERS = ["S", "A", "B", "C"];

function validateTier(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!VALID_TIERS.includes(v)) throw new Error(`--tier must be one of: ${VALID_TIERS.join(", ")}`);
  return v;
}

const VALID_FIT = ["Strong", "Medium", "Weak"];

function validateFit(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!VALID_FIT.includes(v)) throw new Error(`--fit must be one of: ${VALID_FIT.join(", ")}`);
  return v;
}

// "Remote,United States" → ["Remote", "United States"]
function parseLocations(input) {
  return String(input || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Row assembly ----------

// Builds the flat TSV row (v7, 27 columns). `notion_page_id` is left empty —
// the command fills it after pushJobPage succeeds, and writes nothing if it
// doesn't (RFC 063 §4).
function buildManualRow(input, nowIso) {
  const now = nowIso || new Date().toISOString();
  const date = now.slice(0, 10);
  const company = String(input.company || "").trim();
  const title = String(input.title || "").trim();
  if (!company) throw new Error("--company is required");
  if (!title) throw new Error("--title is required");

  const status = validateStatus(input.status);
  const { min, max } = parseSalaryRange(input.salary);
  const fit = validateFit(input.fit);
  const key = makeManualKey({ company, title, date });

  return {
    key,
    source: "Manual",
    jobId: key.slice("manual:".length),
    companyName: company,
    title,
    url: String(input.url || "").trim(),
    locations: parseLocations(input.locations),
    status,
    notion_page_id: "",
    resume_ver: String(input.resumeVer || "").trim(),
    cl_key: "",
    salary_min: min,
    salary_max: max,
    cl_path: "",
    createdAt: now,
    updatedAt: now,
    fit_score: fit,
    fit_rationale: String(input.notes || "").trim(),
    fit_evaluated_at: fit ? now : "",
    skip_reason: "",
    company_people_search_url: "",
    outreach_type: "",
    contact_name: "",
    contact_linkedin: "",
    hm_outreach_status: "To do",
    hm_outreach_date: "",
    applied_date: validateDate(input.appliedDate, "--applied-date"),
  };
}

// Maps a TSV row onto the flat payload pushJobPage consumes. companyName is
// passed through deliberately — pushJobPage resolves it into the relation and
// strips it before buildProperties sees it.
function buildJobFields(row) {
  return {
    title: row.title,
    companyName: row.companyName,
    source: row.source,
    jobId: row.jobId,
    url: row.url,
    status: row.status,
    key: row.key,
    fitScore: row.fit_score,
    dateAdded: row.createdAt.slice(0, 10),
    city: Array.isArray(row.locations) ? row.locations.join(", ") : "",
    state: "Any",
    notes: row.fit_rationale,
    salaryExpectations: formatSalaryDisplay(row.salary_min, row.salary_max),
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    coverLetter: row.cl_key,
    resumeVersion: row.resume_ver,
  };
}

// ---------- Duplicate detection ----------

// Title-specific normalization, deliberately NOT sweep_dedup.normalizeName —
// that one is built for company names (legal suffixes, Cyrillic) and coupling
// the two dedup domains would make both harder to reason about.
function normalizeTitle(title) {
  let t = String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const p of SENIORITY_PREFIXES) {
    if (t.startsWith(p + " ")) {
      t = t.slice(p.length + 1);
      break;
    }
  }
  return t;
}

function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// Returns rows that look like the same posting. Two layers:
//   - exact key match (same company + title + same day)
//   - same company + same normalized title, on any non-archived row
// Archived rows are ignored: re-adding a job that was archived long ago is a
// legitimate action, not a duplicate.
function findDuplicates(apps, row) {
  const key = row.key;
  const company = normalizeCompany(row.companyName);
  const title = normalizeTitle(row.title);
  const out = [];
  for (const a of apps || []) {
    if (a.key === key) {
      out.push({ row: a, reason: "exact key" });
      continue;
    }
    if (a.status === "Archived") continue;
    if (normalizeCompany(a.companyName) === company && normalizeTitle(a.title) === title) {
      out.push({ row: a, reason: `same company + title (status=${a.status})` });
    }
  }
  return out;
}

module.exports = {
  slugify,
  makeManualKey,
  parseSalaryRange,
  validateStatus,
  validateDate,
  validateTier,
  validateFit,
  parseLocations,
  buildManualRow,
  buildJobFields,
  normalizeTitle,
  normalizeCompany,
  findDuplicates,
  VALID_TIERS,
  VALID_FIT,
};
