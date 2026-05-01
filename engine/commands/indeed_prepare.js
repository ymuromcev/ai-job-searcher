// `indeed-prep` command — Phase 1 of the Indeed MCP-bridge flow.
//
// Indeed has no public API; the supported path is "Claude opens indeed.com in
// a browser session via the job-pipeline skill, extracts cards from search
// pages, optionally reads each viewjob page, and writes a normalized JSON
// file". This command produces the *playbook* for that browser session:
//   - 12 (configurable) search URLs covering profile.discovery.indeed.keywords
//   - JS extraction snippet to paste into the browser console
//   - viewjob URL template
//   - filter context (cert blockers / location whitelist / blocklist) for
//     Claude to apply during browser-side filtering
//   - the absolute path where Claude must write `raw_indeed.json` so the
//     existing `engine/modules/discovery/indeed.js` adapter can ingest it on
//     the next `scan` run.
//
// Side effects with --apply (or omitted, since this is a read-only helper by
// default):
//   - Creates profiles/<id>/.indeed-state/ if it doesn't exist.
//   - Writes an empty scaffold raw_indeed.json (`[]`) so a freshly-onboarded
//     profile can run scan immediately without a "file not found" warning.
//   - The Claude session overwrites that scaffold with real entries.
//
// Output: a single JSON document on stdout for Claude to consume.
//
// This command never hits the network and never reads emails / credentials.

const fs = require("fs");
const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { resolveProfilesDir } = require("../core/paths.js");

const DEFAULT_LOCATION = "Sacramento, CA";
const DEFAULT_RADIUS = 25;
const DEFAULT_FROMAGE = 14;
const VIEWJOB_BASE = "https://www.indeed.com/viewjob";
const SEARCH_BASE = "https://www.indeed.com/jobs";

// Browser-console JS snippet. Mirrors the prototype's extraction (Lilia's
// SKILL.md, Stage 6). Returns one row per `a[data-jk]` card on the search
// results page, pipe-separated for easy copy-paste back into chat. The
// truncation lengths mirror prototype constraints (avoid > ~250 chars per
// row to dodge MCP output cutoffs).
const EXTRACTION_SNIPPET = `(() => {
  const cards = [...document.querySelectorAll('a[data-jk]')];
  return cards.map(c => {
    const jk = c.getAttribute('data-jk') || '';
    const title = (c.querySelector('h2 span')?.textContent || '').trim().slice(0, 80);
    const beacon = c.closest('.job_seen_beacon');
    const company = (beacon?.querySelector('[data-testid="company-name"]')?.textContent || '').trim().slice(0, 60);
    const location = (beacon?.querySelector('[data-testid="text-location"]')?.textContent || '').trim().slice(0, 60);
    return [jk, title, company, location].join('|');
  }).join('\\n');
})();`;

// Default cert/license blockers — Lilia has none of these. Profile can
// override via discovery.indeed.filters.cert_blockers.
const DEFAULT_CERT_BLOCKERS = [
  "CMA",
  "COA",
  "COT",
  "RN",
  "LVN",
  "CPC",
  "RDA",
  "RDH",
];

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
  writeFile: (p, content) => fs.writeFileSync(p, content),
  fileExists: (p) => fs.existsSync(p),
  now: () => new Date().toISOString(),
};

// Indeed treats `+` in the query string as a word separator (URL-form-encoded
// space), the same convention `URLSearchParams.toString()` uses. But our
// config keywords come in with literal `+` already (e.g. "medical+receptionist")
// per the prototype's input format — and `URLSearchParams` would re-encode
// those literal pluses to `%2B`, turning a multi-word query into the literal
// string "medical+receptionist" (no whitespace), which returns ~zero results.
//
// Fix: normalize input by treating any literal `+` as a word boundary, then
// percent-encode, then convert encoded spaces (`%20`) back to `+`. This
// matches the URL shape the prototype produced:
//   q=medical+receptionist&l=Sacramento%2C+CA
function indeedEncode(s) {
  return encodeURIComponent(String(s).replace(/\+/g, " ")).replace(/%20/g, "+");
}

function buildUrl(keyword, { location, radius, fromage }) {
  return (
    `${SEARCH_BASE}?q=${indeedEncode(keyword)}` +
    `&l=${indeedEncode(location)}` +
    `&radius=${encodeURIComponent(radius)}` +
    `&fromage=${encodeURIComponent(fromage)}`
  );
}

function buildScanUrls(keywords, opts) {
  return keywords.map((kw) => ({
    keyword: kw,
    url: buildUrl(kw, opts),
  }));
}

function buildInstructions({ ingestFile, viewjobBase, batchHint }) {
  return [
    `1. Open each scan_urls[].url in a Chrome tab (recommended: 2 tabs in parallel to dodge CAPTCHA).`,
    `2. Paste extraction_snippet into the browser console; copy the pipe-separated rows.`,
    `3. For each row: split on '|' → [jk, title, company, location].`,
    `4. Apply browser-side filters (in order, reject early):`,
    `   - location_blocklist: skip if location matches any entry.`,
    `   - location_whitelist (if non-empty): keep ONLY if location matches.`,
    `   - title obvious-noise: driver / warehouse / nurse / therapist / physician.`,
    `5. For surviving rows: open viewjob_template with jk → check the JD body for cert_blockers (any single match → reject).`,
    `6. Capture per surviving entry: { jk, title, company, location, url?, postedAt? }.`,
    `7. Write the array to ingest_file (overwrite). The existing file is a scaffold — safe to replace.`,
    `8. Run \`node engine/cli.js scan --profile <id>\`. The indeed adapter will normalize and append fresh rows to applications.tsv with status="To Apply".`,
    batchHint ? `Hint: limit one prep run to ~${batchHint} entries to keep MCP output readable.` : null,
  ].filter(Boolean);
}

function readIndeedConfig(profile) {
  const indeed = (profile.discovery && profile.discovery.indeed) || null;
  if (!indeed) {
    throw new Error(
      `profile "${profile.id}" has no discovery.indeed config — add it to profile.json`
    );
  }
  if (!Array.isArray(indeed.keywords) || indeed.keywords.length === 0) {
    throw new Error(
      `profile "${profile.id}" discovery.indeed.keywords must be a non-empty array`
    );
  }
  return {
    keywords: indeed.keywords,
    location: indeed.location || DEFAULT_LOCATION,
    radius: Number.isFinite(indeed.radius) ? indeed.radius : DEFAULT_RADIUS,
    fromage: Number.isFinite(indeed.fromage) ? indeed.fromage : DEFAULT_FROMAGE,
    ingestFile: indeed.ingest_file || ".indeed-state/raw_indeed.json",
    filters: {
      cert_blockers: Array.isArray(indeed.filters && indeed.filters.cert_blockers)
        ? indeed.filters.cert_blockers
        : DEFAULT_CERT_BLOCKERS,
      location_whitelist: Array.isArray(indeed.filters && indeed.filters.location_whitelist)
        ? indeed.filters.location_whitelist
        : [],
      location_blocklist: Array.isArray(indeed.filters && indeed.filters.location_blocklist)
        ? indeed.filters.location_blocklist
        : [],
    },
    batchHint: Number.isFinite(indeed.batch_hint) ? indeed.batch_hint : 30,
  };
}

function makeIndeedPrepCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function indeedPrepCommand(ctx) {
    const { profileId, flags, stdout, stderr } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const profile = deps.loadProfile(profileId, { profilesDir });

    let cfg;
    try {
      cfg = readIndeedConfig(profile);
    } catch (err) {
      stderr(`error: ${err.message}`);
      return 1;
    }

    const ingestPath = path.isAbsolute(cfg.ingestFile)
      ? cfg.ingestFile
      : path.join(profile.paths.root, cfg.ingestFile);
    const ingestDir = path.dirname(ingestPath);

    const scanUrls = buildScanUrls(cfg.keywords, {
      location: cfg.location,
      radius: cfg.radius,
      fromage: cfg.fromage,
    });

    const payload = {
      profile_id: profileId,
      generated_at: deps.now(),
      ingest_file: ingestPath,
      scan_urls: scanUrls,
      extraction_snippet: EXTRACTION_SNIPPET,
      viewjob_template: `${VIEWJOB_BASE}?jk={jk}`,
      filters: cfg.filters,
      instructions: buildInstructions({
        ingestFile: ingestPath,
        viewjobBase: VIEWJOB_BASE,
        batchHint: cfg.batchHint,
      }),
    };

    if (flags.dryRun) {
      stdout(`(dry-run) would create ${ingestDir}/ and seed empty raw_indeed.json`);
      stdout(`(dry-run) ${scanUrls.length} scan URLs, ${cfg.filters.cert_blockers.length} cert blockers`);
      return 0;
    }

    // Side effects: ensure state dir + scaffold ingest file (only if missing —
    // never overwrite Claude's pending work).
    deps.ensureDir(ingestDir);
    if (!deps.fileExists(ingestPath)) {
      deps.writeFile(ingestPath, "[]\n");
    }

    stdout(JSON.stringify(payload, null, 2));
    return 0;
  };
}

module.exports = makeIndeedPrepCommand();
module.exports.makeIndeedPrepCommand = makeIndeedPrepCommand;
module.exports.buildUrl = buildUrl;
module.exports.buildScanUrls = buildScanUrls;
module.exports.buildInstructions = buildInstructions;
module.exports.readIndeedConfig = readIndeedConfig;
module.exports.EXTRACTION_SNIPPET = EXTRACTION_SNIPPET;
module.exports.DEFAULT_CERT_BLOCKERS = DEFAULT_CERT_BLOCKERS;
module.exports.SEARCH_BASE = SEARCH_BASE;
module.exports.VIEWJOB_BASE = VIEWJOB_BASE;
