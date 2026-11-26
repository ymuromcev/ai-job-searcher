// Walmart careers (careers.walmart.com) keyword-search adapter. RFC 073.
//
// Walmart retired its public Workday tenant (walmart.wd5 / WalmartExternal
// answers HTTP 422 to every jobs query since 2026-11), so the generic
// `workday` adapter cannot see Walmart, Sam's Club or VIZIO postings. The
// only public listing left is careers.walmart.com, whose search page calls a
// persisted GraphQL query:
//
//   POST https://careers.walmart.com/api/graphql
//   { queryId: <persisted id>, variables: { chatRequest: { ...,
//       context: { job_search_context: { refined_query, job_page, ... } } } } }
//
// Response: data.jobSearchAssistant.tool_messages[0].artifact
//   { totalResults, page_size, jobs: [{ job_id, title, jobPostingTitle, city,
//     state, country, additionalLocationCities, minPay, maxPay, payFrequency,
//     brand, categories, jobPostingStartDate }] }
//
// Walmart lists ~20k open postings (mostly store roles) and the search is
// semantic (every query "matches" everything, ranked by relevance), so this
// adapter is NOT fetch-all: it runs several focused keyword queries
// (`searchTexts`, like the workday adapter's multi-query mode) and keeps the
// top page of each. Pages after the first come back empty outside a browser
// session (checked 2026-11-26), so `maxPages` defaults to 1; the loop still
// stops on the first empty page if Walmart ever serves more. Relevance
// filtering happens downstream in core/filter.js.
//
// Target (companies.tsv row; extra_json is merged into the target):
//   { name, slug, searchTexts?: string[], searchText?: string, maxPages?: number }
//   default queries: DEFAULT_QUERIES below.
//
// The per-job page (https://careers.walmart.com/us/en/jobs/{job_id}) is
// server-rendered; core/jd_cache.js fetches the JD body from it.

const { fetchJsonPost, runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, dedupeLocations } = require("./_normalize.js");

const SOURCE = "walmart";
const API_URL = "https://careers.walmart.com/api/graphql";
const JOB_URL_BASE = "https://careers.walmart.com/us/en/jobs/";
// Persisted query id the careers site's own search page sends.
const QUERY_ID = "b0467c1f-f578-4261-9280-0ea4614f251c";
const DEFAULT_QUERIES = [
  "Senior Product Manager",
  "Senior Product Manager Sunnyvale CA",
  "Senior Product Manager San Bruno CA",
  "Senior Product Manager AI",
  "Product Manager California",
];
const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 20; // page size is 10 → at most 200 rows per query
const JOB_ID_RE = /^R-\d{5,9}$/;

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function formatLocation(city, state) {
  const c = titleCase(sanitizeText(city));
  const st = sanitizeText(state).toUpperCase();
  if (c && st) return `${c}, ${st}`;
  return c || st || "";
}

function toIsoDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function queriesFor(target) {
  if (Array.isArray(target.searchTexts) && target.searchTexts.length) {
    const qs = target.searchTexts.map((q) => sanitizeText(q)).filter(Boolean);
    if (qs.length) return qs;
  }
  const one = sanitizeText(target.searchText);
  return one ? [one] : DEFAULT_QUERIES;
}

function buildBody(query, page, threadId) {
  return {
    queryId: QUERY_ID,
    variables: {
      chatRequest: {
        messages: [
          { role: "user", content: [{ type: "text", text: `Show me page number ${page + 1}` }] },
        ],
        thread_id: threadId,
        channel: "job_search",
        context: {
          job_search_context: {
            refined_query: query,
            direct_search: true,
            locale: "en_US",
            sort: "relevance",
            active_tab: "jobs",
            management_levels: [],
            content_page: 0,
            future_roles_page: 0,
            job_page: page,
          },
        },
      },
    },
    headers: {},
  };
}

function extractArtifact(body) {
  const assistant = body && body.data && body.data.jobSearchAssistant;
  const msgs = assistant && assistant.tool_messages;
  if (!Array.isArray(msgs) || !msgs.length) return null;
  const a = msgs[0] && msgs[0].artifact;
  return a && typeof a === "object" ? a : null;
}

function extraCity(x) {
  if (typeof x === "string") {
    const s = sanitizeText(x);
    const m = /^(.*?),\s*([A-Za-z]{2})$/.exec(s);
    return m ? formatLocation(m[1], m[2]) : titleCase(s);
  }
  return x && typeof x === "object" ? formatLocation(x.city, x.state) : "";
}

function mapJob(target, raw) {
  if (!raw || typeof raw !== "object") return null;
  const jobId = sanitizeText(raw.job_id);
  if (!JOB_ID_RE.test(jobId)) return null;
  const title = sanitizeText(raw.jobPostingTitle || raw.title);
  if (!title) return null;
  const extra = Array.isArray(raw.additionalLocationCities)
    ? raw.additionalLocationCities.map(extraCity)
    : [];
  const locations = dedupeLocations([formatLocation(raw.city, raw.state), ...extra]);
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((x) => sanitizeText(x)).filter(Boolean)
    : [];
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: target.name,
    jobId,
    title,
    url: `${JOB_URL_BASE}${jobId}`,
    locations,
    team: categories[0] || null,
    postedAt: toIsoDate(raw.jobPostingStartDate),
    rawExtra: {
      brand: sanitizeText(raw.brand) || null,
      country: sanitizeText(raw.country) || null,
      minPay: Number.isFinite(raw.minPay) ? raw.minPay : null,
      maxPay: Number.isFinite(raw.maxPay) ? raw.maxPay : null,
      payFrequency: sanitizeText(raw.payFrequency) || null,
      categories,
    },
  };
  assertJob(job);
  return job;
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  return runTargets(targets, c, async (target) => {
    if (!target || !target.slug || !target.name) return [];
    const seen = new Map();
    const requested = Number(target.maxPages);
    const maxPages =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_PAGES_CAP)
        : DEFAULT_MAX_PAGES;
    for (const query of queriesFor(target)) {
      const threadId = `S-${Date.now()}-ajs-${Math.random().toString(36).slice(2, 10)}`;
      for (let page = 0; page < maxPages; page += 1) {
        const body = await fetchJsonPost(c.fetchFn, API_URL, buildBody(query, page, threadId), {
          signal: c.signal,
          headers: { Origin: "https://careers.walmart.com" },
        });
        const artifact = extractArtifact(body);
        const raws = artifact && Array.isArray(artifact.jobs) ? artifact.jobs : [];
        if (!raws.length) break;
        for (const r of raws) {
          const job = mapJob(target, r);
          if (job && !seen.has(job.jobId)) seen.set(job.jobId, job);
        }
        const total = Number(artifact.totalResults || artifact.total_jobs);
        const size = Number(artifact.page_size) || raws.length;
        if (Number.isFinite(total) && total > 0 && (page + 1) * size >= total) break;
      }
    }
    return Array.from(seen.values());
  });
}

module.exports = {
  source: SOURCE,
  discover,
  _internal: { mapJob, buildBody, extractArtifact, queriesFor, QUERY_ID, API_URL },
};
