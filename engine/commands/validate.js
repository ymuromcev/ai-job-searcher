// `validate` command: pre-flight checks on profile state.
//
//   1. TSV hygiene: applications.tsv loads without errors, jobs.tsv too.
//   2. company_cap: count active applications per company against profile
//      filter_rules.company_cap (max_active + overrides).
//   3. URL liveness: HEAD-ping each active application's job URL with bounded
//      concurrency.
//
// URL-liveness is SSRF-hardened: URLs from untrusted ATS origins can only be
// pinged when their scheme is http(s) and their host is not loopback /
// link-local / private. Redirects are NOT followed (`redirect: "manual"`).
// HEAD never falls back to GET — if the server returns 405/501 we report the
// URL as indeterminate-but-not-dead (ok=true, status=405, indeterminate=true)
// rather than issuing a body-less GET that could trigger mutating endpoints.

const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const jobsTsv = require("../core/jobs_tsv.js");
const applications = require("../core/applications_tsv.js");
const { matchBlocklists } = require("../core/filter.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { defaultFetch } = require("../modules/discovery/_http.js");

// 8-status set: To Apply / Applied / Interview / Offer / Rejected / Closed /
// No Response / Archived. "Active" = still in flight (worth re-validating URL).
const ACTIVE_STATUSES = new Set(["To Apply", "Applied", "Interview", "Offer"]);
// Rows eligible for retro blocklist sweep. Re-screen only "not yet applied"
// rows — Applied/Interview/Offer are kept as-is.
const RETRO_SWEEP_STATUSES = new Set(["To Apply"]);
const DEFAULT_URL_CAP = 500;
const DEFAULT_PING_TIMEOUT_MS = 5000;
const DEFAULT_PING_CONCURRENCY = 8;

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadJobs: jobsTsv.load,
  loadApplications: applications.load,
  saveApplications: applications.save,
  fetchFn: defaultFetch,
  now: () => new Date().toISOString(),
};

// --- SSRF guard -------------------------------------------------------------

function ipv4Octets(host) {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  const oct = host.split(".").map((n) => Number(n));
  if (oct.some((n) => n < 0 || n > 255)) return null;
  return oct;
}

function isPrivateIpv4(host) {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 255 && b === 255) return true; // broadcast
  return false;
}

function isPrivateIpv6(host) {
  // Host may be bracketed — URL parser strips brackets on .hostname.
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local
  return false;
}

function isSafeLivenessUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `blocked scheme ${u.protocol}` };
  }
  // WHATWG URL keeps brackets on IPv6 hostnames (e.g. "[::1]"). Strip them so
  // our IPv6 check can match the raw address.
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host) return { ok: false, reason: "empty host" };
  // Treat hostnames that look like an IPv4 dotted quad as such.
  if (ipv4Octets(host) && isPrivateIpv4(host)) {
    return { ok: false, reason: `blocked private/loopback host ${host}` };
  }
  // IPv6 literal.
  if (host.includes(":") && isPrivateIpv6(host)) {
    return { ok: false, reason: `blocked private/loopback host ${host}` };
  }
  // Common loopback hostnames.
  if (host === "localhost" || host === "localhost.localdomain") {
    return { ok: false, reason: `blocked loopback host ${host}` };
  }
  return { ok: true };
}

// --- Ping -------------------------------------------------------------------

async function pingUrl(
  fetchFn,
  url,
  { timeoutMs = DEFAULT_PING_TIMEOUT_MS } = {}
) {
  if (!url) return { url, status: 0, ok: false, error: "no url" };
  const safe = isSafeLivenessUrl(url);
  if (!safe.ok) {
    return { url, status: 0, ok: false, error: safe.reason, blocked: true };
  }
  try {
    const res = await fetchFn(url, {
      method: "HEAD",
      timeoutMs,
      retries: 0,
      redirect: "manual",
    });
    // 405 / 501 / opaque-redirect (status 0 when redirect: manual blocks a 3xx):
    // server rejects HEAD or hides the target. We do NOT fall back to GET
    // (that could trigger mutating endpoints). Treat as indeterminate but
    // not a failure.
    if (res.status === 405 || res.status === 501 || res.status === 0) {
      return { url, status: res.status, ok: true, error: null, indeterminate: true };
    }
    return { url, status: res.status, ok: res.ok, error: null };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.message };
  }
}

async function pingAll(
  fetchFn,
  urls,
  { concurrency = DEFAULT_PING_CONCURRENCY, timeoutMs = DEFAULT_PING_TIMEOUT_MS } = {}
) {
  const results = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i;
      i += 1;
      results[idx] = await pingUrl(fetchFn, urls[idx], { timeoutMs });
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// --- Domain checks ----------------------------------------------------------

function checkCompanyCap(apps, filterRules) {
  const cap = (filterRules && filterRules.company_cap) || {};
  const overrides = cap.overrides || {};
  const maxDefault = Number.isFinite(cap.max_active) ? cap.max_active : Infinity;
  const counts = {};
  for (const a of apps) {
    if (!ACTIVE_STATUSES.has(a.status)) continue;
    counts[a.companyName] = (counts[a.companyName] || 0) + 1;
  }
  const violations = [];
  for (const [name, n] of Object.entries(counts)) {
    const limit = Object.prototype.hasOwnProperty.call(overrides, name)
      ? overrides[name]
      : maxDefault;
    if (n > limit) violations.push({ company: name, count: n, limit });
  }
  return { counts, violations };
}

function makeValidateCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function validateCommand(ctx) {
    const { profileId, flags, stdout } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const dataDir = ctx.dataDir || path.resolve(process.cwd(), "data");

    let profile;
    try {
      profile = deps.loadProfile(profileId, { profilesDir });
    } catch (err) {
      ctx.stderr(`error: ${err.message}`);
      return 1;
    }

    let issues = 0;

    // 1. TSV hygiene.
    let appsResult, jobsResult;
    try {
      appsResult = deps.loadApplications(path.join(profile.paths.root, "applications.tsv"));
      stdout(`applications.tsv: ${appsResult.apps.length} rows, ok`);
    } catch (err) {
      ctx.stderr(`applications.tsv: PARSE ERROR — ${err.message}`);
      issues += 1;
      appsResult = { apps: [] };
    }
    try {
      jobsResult = deps.loadJobs(path.join(dataDir, "jobs.tsv"));
      stdout(`jobs.tsv: ${jobsResult.jobs.length} rows, ok`);
    } catch (err) {
      ctx.stderr(`jobs.tsv: PARSE ERROR — ${err.message}`);
      issues += 1;
    }

    // 2. company_cap.
    const cap = checkCompanyCap(appsResult.apps, profile.filterRules || {});
    if (cap.violations.length === 0) {
      stdout(`company_cap: ok (${Object.keys(cap.counts).length} active companies)`);
    } else {
      issues += cap.violations.length;
      ctx.stderr(`company_cap: ${cap.violations.length} violation(s)`);
      for (const v of cap.violations) {
        ctx.stderr(`  ${v.company}: ${v.count} active > limit ${v.limit}`);
      }
    }

    // 3. URL liveness.
    const urlCap = Number.isFinite(ctx.urlCap) ? ctx.urlCap : DEFAULT_URL_CAP;
    const pingTimeoutMs = Number.isFinite(ctx.pingTimeoutMs)
      ? ctx.pingTimeoutMs
      : DEFAULT_PING_TIMEOUT_MS;
    const pingConcurrency = Number.isFinite(ctx.pingConcurrency)
      ? ctx.pingConcurrency
      : DEFAULT_PING_CONCURRENCY;
    const activeAppsAll = appsResult.apps.filter((a) => ACTIVE_STATUSES.has(a.status) && a.url);
    const activeApps = activeAppsAll.slice(0, urlCap);
    const skipped = activeAppsAll.length - activeApps.length;
    if (activeApps.length === 0) {
      stdout(`url_liveness: no active applications with URLs to check`);
    } else if (flags.dryRun) {
      stdout(`url_liveness: would HEAD-ping ${activeApps.length} URLs (dry-run)`);
    } else {
      if (skipped > 0) {
        ctx.stderr(
          `url_liveness: pinging first ${activeApps.length} of ${activeAppsAll.length} URLs (cap ${urlCap}); raise ctx.urlCap to check all`
        );
      } else {
        stdout(`url_liveness: HEAD-pinging ${activeApps.length} URLs (concurrency ${pingConcurrency})…`);
      }
      const results = await pingAll(deps.fetchFn, activeApps.map((a) => a.url), {
        concurrency: pingConcurrency,
        timeoutMs: pingTimeoutMs,
      });
      const blocked = results.filter((r) => r.blocked);
      const dead = results.filter((r) => !r.ok && !r.blocked);
      if (blocked.length > 0) {
        issues += blocked.length;
        ctx.stderr(`url_liveness: ${blocked.length} URL(s) blocked by SSRF guard`);
        for (const r of blocked.slice(0, 20)) {
          ctx.stderr(`  BLOCKED ${r.url} (${r.error})`);
        }
        if (blocked.length > 20) ctx.stderr(`  … and ${blocked.length - 20} more`);
      }
      if (dead.length === 0 && blocked.length === 0) {
        stdout(`url_liveness: ok (${results.length}/${results.length} alive)`);
      } else if (dead.length > 0) {
        issues += dead.length;
        ctx.stderr(`url_liveness: ${dead.length} dead/unreachable`);
        for (const r of dead.slice(0, 20)) {
          ctx.stderr(`  ${r.status || "ERR"} ${r.url}${r.error ? ` (${r.error})` : ""}`);
        }
        if (dead.length > 20) ctx.stderr(`  … and ${dead.length - 20} more`);
      }
    }

    // 4. Retro blocklist sweep: re-apply title/company/location blocklists to
    // existing "To Apply" rows (the only pre-apply triage state in the 8-status
    // set). Catches the case where a pattern was added to filter_rules.json
    // after old rows landed — prototype parity with validate_inbox.js. Since
    // schema v3 (G-5, 2026-05-03) TSV rows carry `location`, so location
    // blocklist now exercises here too (rows without a backfilled location are
    // simply not matched against location patterns — empty string never hits).
    const filterRules = profile.filterRules || {};
    const hasBlocklistRules =
      (Array.isArray(filterRules.company_blocklist) && filterRules.company_blocklist.length > 0) ||
      (Array.isArray(filterRules.title_blocklist) && filterRules.title_blocklist.length > 0) ||
      (Array.isArray(filterRules.location_blocklist) && filterRules.location_blocklist.length > 0);
    if (appsResult.apps.length > 0 && hasBlocklistRules) {
      const matches = [];
      for (const app of appsResult.apps) {
        if (!RETRO_SWEEP_STATUSES.has(app.status)) continue;
        const reason = matchBlocklists(
          { company: app.companyName, role: app.title, location: app.location || "" },
          filterRules
        );
        if (reason) matches.push({ app, reason });
      }
      if (matches.length === 0) {
        stdout(`retro_sweep: ok (${appsResult.apps.filter((a) => RETRO_SWEEP_STATUSES.has(a.status)).length} rows re-screened)`);
      } else if (flags.apply) {
        const byKey = new Map(matches.map((m) => [m.app.key, m.reason]));
        const now = deps.now();
        const updated = appsResult.apps.map((a) =>
          byKey.has(a.key)
            ? { ...a, status: "Archived", updatedAt: now }
            : a
        );
        deps.saveApplications(path.join(profile.paths.root, "applications.tsv"), updated);
        stdout(`retro_sweep: archived ${matches.length} row(s) matching blocklists`);
        for (const m of matches.slice(0, 20)) {
          stdout(`  ARCHIVED ${m.app.companyName} — ${m.app.title} (${formatReason(m.reason)})`);
        }
        if (matches.length > 20) stdout(`  … and ${matches.length - 20} more`);
      } else {
        issues += matches.length;
        ctx.stderr(`retro_sweep: ${matches.length} row(s) now match blocklists (pass --apply to archive)`);
        for (const m of matches.slice(0, 20)) {
          ctx.stderr(`  MATCH ${m.app.companyName} — ${m.app.title} (${formatReason(m.reason)})`);
        }
        if (matches.length > 20) ctx.stderr(`  … and ${matches.length - 20} more`);
      }
    }

    if (issues > 0) {
      ctx.stderr(`validation: ${issues} issue(s) found`);
      return 1;
    }
    stdout(`validation: ok`);
    return 0;
  };
}

function formatReason(reason) {
  if (reason.kind === "company_blocklist") return `company_blocklist: ${reason.company}`;
  if (reason.kind === "title_blocklist") return `title_blocklist: "${reason.pattern}"${reason.why ? ` — ${reason.why}` : ""}`;
  if (reason.kind === "location_blocklist") return `location_blocklist: ${reason.match}`;
  return reason.kind;
}

module.exports = makeValidateCommand();
module.exports.makeValidateCommand = makeValidateCommand;
module.exports.checkCompanyCap = checkCompanyCap;
module.exports.pingUrl = pingUrl;
module.exports.pingAll = pingAll;
module.exports.isSafeLivenessUrl = isSafeLivenessUrl;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.RETRO_SWEEP_STATUSES = RETRO_SWEEP_STATUSES;
module.exports.DEFAULT_URL_CAP = DEFAULT_URL_CAP;
module.exports.DEFAULT_PING_TIMEOUT_MS = DEFAULT_PING_TIMEOUT_MS;
module.exports.DEFAULT_PING_CONCURRENCY = DEFAULT_PING_CONCURRENCY;
