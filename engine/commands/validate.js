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

const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const { checkPositiveGate } = require("../core/profile_loader.js");
const jobsTsv = require("../core/jobs_tsv.js");
const applications = require("../core/applications_tsv.js");
const { matchBlocklists } = require("../core/filter.js");
const { checkFreshness: checkFitProfileFreshness } = require("../core/fit_profile.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { defaultFetch } = require("../modules/discovery/_http.js");
const { planDedup } = require("../core/tsv_dedup.js");
const notion = require("../core/notion_sync.js");
const { validateProfileDeep, formatIssue } = require("../core/validator.js");
const {
  EXPECTED_STATUS_OPTIONS,
  extractStatusOptions,
  checkStatusSchema,
} = require("../core/notion_status_options.js");

// RFC 014: TSV-level 9-status set — Inbox / To Apply / Applied / Interview /
// Offer / Rejected / Closed / No Response / Archived. (Notion DBs keep the
// 8-status set; "Inbox" is local-only.) "Active" = still in flight (worth
// re-validating URL). "Inbox" is intentionally NOT active — fresh rows haven't
// passed prepare's URL-check yet, so re-pinging them is wasted work; the
// next `prepare --phase pre` will URL-check them as part of normal flow.
const ACTIVE_STATUSES = new Set(["To Apply", "Applied", "Interview", "Offer"]);
// Rows eligible for retro blocklist sweep. Re-screen "not yet applied" rows
// — both "Inbox" (just-scanned, not yet triaged) AND "To Apply" (prepared,
// awaiting submit). Applied / Interview / Offer are kept as-is.
const RETRO_SWEEP_STATUSES = new Set(["Inbox", "To Apply"]);
const DEFAULT_URL_CAP = 500;
const DEFAULT_PING_TIMEOUT_MS = 5000;
const DEFAULT_PING_CONCURRENCY = 8;

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadJobs: jobsTsv.load,
  loadApplications: applications.load,
  saveApplications: applications.save,
  fetchFn: defaultFetch,
  makeNotionClient: notion.makeClient,
  fetchDataSourceSchema: notion.fetchDataSourceSchema,
  now: () => new Date().toISOString(),
  copyFileSync: (src, dst) => fs.copyFileSync(src, dst),
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

async function pingUrl(fetchFn, url, { timeoutMs = DEFAULT_PING_TIMEOUT_MS } = {}) {
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
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
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

// BL-9 Step 6: collapse rows with the same canonical key (after stripping
// ATS prefixes recursively). Read-only by default; --apply rewrites the TSV
// after backing up to applications.tsv.pre-dedup-<timestamp>. Suspicious
// groups (rows disagreeing on company or url path) are surfaced for human
// review and never auto-collapsed.
function tsvBackupPath(tsvPath, nowIso) {
  const stamp = String(nowIso).replace(/[:.]/g, "-");
  return `${tsvPath}.pre-dedup-${stamp}`;
}

async function runDedup(ctx, deps, profile) {
  const { flags, stdout, stderr } = ctx;
  const tsvPath = path.join(profile.paths.root, "applications.tsv");

  let appsResult;
  try {
    appsResult = deps.loadApplications(tsvPath);
  } catch (err) {
    stderr(`applications.tsv: PARSE ERROR — ${err.message}`);
    return 1;
  }

  const plan = planDedup(appsResult.apps);
  const dryRun = !flags.apply;
  const header = dryRun ? "TSV dedup report (dry-run)" : "TSV dedup (--apply)";
  stdout(header);

  if (plan.pairs === 0 && plan.suspicious.length === 0) {
    stdout(`  no duplicates found, nothing to do (${appsResult.apps.length} rows scanned)`);
    return 0;
  }

  if (plan.pairs > 0) {
    const dropCount = plan.dropped.length;
    stdout(`  found: ${plan.pairs} duplicate group(s)`);
    stdout(`  → keep ${plan.kept.length} rows, drop ${dropCount} row(s)`);
    stdout(`  by reason:`);
    for (const [reason, n] of Object.entries(plan.byReason)) {
      stdout(`    ${reason}: ${n}`);
    }
    stdout(`  examples:`);
    for (const g of plan.pairsByGroup.slice(0, 3)) {
      const win = g.winner;
      stdout(
        `    ${win.key.padEnd(36)} → keep (${win.status}${win.notion_page_id ? ", has notion_page_id" : ""}, updatedAt ${win.updatedAt})`
      );
      for (const l of g.losers) {
        stdout(
          `    ${String(l.key).padEnd(36)} → drop (${l.status}${l.notion_page_id ? ", has notion_page_id" : ""}, updatedAt ${l.updatedAt})`
        );
      }
    }
    if (plan.pairsByGroup.length > 3) {
      stdout(`    … and ${plan.pairsByGroup.length - 3} more group(s)`);
    }
  }

  if (plan.suspicious.length > 0) {
    stdout(``);
    stdout(`  suspicious (not deduped — same canonical key, different company or url):`);
    for (const s of plan.suspicious.slice(0, 10)) {
      stdout(`    canonical=${s.canonical} (${s.reason})`);
      for (const r of s.rows) {
        stdout(
          `      ${r.key}  status=${r.status}  company="${r.companyName}"  url=${r.url || "(none)"}`
        );
      }
    }
    if (plan.suspicious.length > 10) {
      stdout(`    … and ${plan.suspicious.length - 10} more group(s)`);
    }
    stdout(`  → no automatic action; review manually`);
  }

  if (dryRun) {
    if (plan.pairs > 0) {
      stdout(``);
      stdout(`  rerun with --apply to write changes`);
    }
    // Dry-run with only suspicious findings still exits 0; suspicious is
    // an advisory, not a failure.
    return 0;
  }

  // --apply path
  if (plan.pairs === 0) {
    stdout(`  no auto-collapsable duplicates; suspicious groups left as-is`);
    return 0;
  }
  const backupPath = tsvBackupPath(tsvPath, deps.now());
  if (fs.existsSync(tsvPath)) {
    deps.copyFileSync(tsvPath, backupPath);
    stdout(`  backup written: ${path.basename(backupPath)}`);
  }
  deps.saveApplications(tsvPath, plan.kept);
  stdout(`  TSV rewritten: ${plan.kept.length} rows (was ${appsResult.apps.length})`);
  return 0;
}

function makeValidateCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function validateCommand(ctx) {
    const { profileId, flags, stdout } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);
    const dataDir = ctx.dataDir || path.resolve(process.cwd(), "data");

    let profile;
    try {
      // Silence loadProfile's stderr warning — we report the same gap as a
      // structured issue below (RFC 033) so the user sees it once with
      // explicit "exit 1" semantics.
      profile = deps.loadProfile(profileId, { profilesDir, warn: () => {} });
    } catch (err) {
      ctx.stderr(`error: ${err.message}`);
      return 1;
    }

    // --dedup is a standalone task: just run the dedup planner + writer and
    // exit. We don't gate it behind the rest of validate (URL pings etc.) so
    // users can collapse rows without paying for a full validation pass.
    if (flags.dedup) {
      return runDedup(ctx, deps, profile);
    }

    let issues = 0;

    // 0. Deep profile validation (RFC 037 / BL-99): structural shape, semantic
    // coherence, cross-references. Catches drift in filter_rules / role_targets
    // / geo / notion before downstream commands hit opaque failures. Errors
    // increment `issues` (gate); warns are surfaced but don't gate.
    const deep = validateProfileDeep(
      profile,
      { profileRoot: profile.paths && profile.paths.root, dataDir },
      {}
    );
    const deepErrors = deep.issues.filter((i) => i.severity === "error");
    const deepWarns = deep.issues.filter((i) => i.severity === "warn");
    if (deepErrors.length === 0 && deepWarns.length === 0) {
      stdout(`profile_schema: ok`);
    } else {
      for (const iss of deep.issues) {
        if (iss.severity === "error") {
          ctx.stderr(formatIssue(iss));
        } else {
          stdout(formatIssue(iss));
        }
      }
      issues += deepErrors.length;
    }

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

    // BL-13 (2026-05-06): read-only dedup detect. We do NOT collapse here —
    // `prepare --phase pre` auto-collapses non-suspicious groups on its next
    // run, so this is purely an advisory so the user knows the engine sees
    // duplicates. Suspicious groups are surfaced too; they're never auto-
    // collapsed and need manual review via `validate --dedup`.
    if (appsResult.apps.length > 0) {
      const dedupPlan = planDedup(appsResult.apps);
      if (dedupPlan.pairs > 0) {
        stdout(
          `tsv_dedup: ${dedupPlan.pairs} duplicate group(s) detected ` +
            `(will be auto-collapsed on the next \`prepare --phase pre\` run)`
        );
      }
      if (dedupPlan.suspicious.length > 0) {
        ctx.stderr(
          `tsv_dedup: ${dedupPlan.suspicious.length} suspicious group(s) ` +
            `(rows disagree on company or url) — manual review required, ` +
            `run \`validate --dedup\` for details`
        );
      }
      if (dedupPlan.pairs === 0 && dedupPlan.suspicious.length === 0) {
        stdout(`tsv_dedup: ok (no duplicates)`);
      }
    }
    try {
      jobsResult = deps.loadJobs(path.join(dataDir, "jobs.tsv"));
      stdout(`jobs.tsv: ${jobsResult.jobs.length} rows, ok`);
    } catch (err) {
      ctx.stderr(`jobs.tsv: PARSE ERROR — ${err.message}`);
      issues += 1;
    }

    // 1.5. RFC 033 — positive title gate (role_targets / title_requirelist).
    // Profiles without an allowlist accept any non-blocked title, which is
    // how lilia ended up with phlebotomy / ED-tech rows in her Inbox
    // (2026-05-18). Fail loud here so cron / CI flag the gap.
    const gateWarning = checkPositiveGate(profile.filterRules, profile.id);
    if (gateWarning) {
      issues += 1;
      ctx.stderr(`filter_rules: ${gateWarning}`);
    } else {
      stdout(`filter_rules: ok (positive title gate present)`);
    }

    // 1.7. RFC 060 / BL-192 — fit digest freshness. `fit_profile.md` is
    // generated from the storybank; if a story changed (or was added) and the
    // generator was not re-run, the fit evaluator would score against a stale
    // achievement set. Profiles without a storybank skip this (not applicable).
    const fitFresh = checkFitProfileFreshness(profile.paths.root, profile.id);
    if (!fitFresh.applicable) {
      // No storybank — fit_profile.md is optional; nothing to validate.
    } else if (fitFresh.ok) {
      stdout(`fit_profile: ok (digest in sync with storybank)`);
    } else {
      issues += fitFresh.issues.length;
      for (const msg of fitFresh.issues) ctx.stderr(`fit_profile: ${msg}`);
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
        stdout(
          `url_liveness: HEAD-pinging ${activeApps.length} URLs (concurrency ${pingConcurrency})…`
        );
      }
      const results = await pingAll(
        deps.fetchFn,
        activeApps.map((a) => a.url),
        {
          concurrency: pingConcurrency,
          timeoutMs: pingTimeoutMs,
        }
      );
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

    // 3.5. Notion Status schema (BL-18). Read-only: one retrieve to make sure
    // the per-profile Jobs Pipeline DB still exposes every Status option the
    // pipeline writes. A renamed / deleted option ("Applied" → "Submitted")
    // would otherwise blow up live `pages.update` with an opaque Notion
    // `validation_error`. WARN-only — never increments `issues`. Skipped
    // silently when Notion isn't configured for the profile or no token is
    // available; `validate` must keep working offline.
    const notionConf = profile && profile.notion;
    const jobsDbId = notionConf && notionConf.jobs_pipeline_db_id;
    const statusFieldName =
      (notionConf &&
        notionConf.property_map &&
        notionConf.property_map.status &&
        notionConf.property_map.status.field) ||
      "Status";
    let notionToken;
    try {
      const secrets = deps.loadSecrets(profileId, ctx.env || process.env);
      notionToken = secrets && secrets.NOTION_TOKEN;
    } catch {
      notionToken = null;
    }
    if (!jobsDbId || !notionToken) {
      stdout(`notion_status_schema: skipped (notion not configured for profile)`);
    } else if (flags.dryRun) {
      stdout(`notion_status_schema: skipped (dry-run)`);
    } else {
      try {
        const client = deps.makeNotionClient(notionToken);
        const dataSource = await deps.fetchDataSourceSchema(client, jobsDbId);
        const actual = extractStatusOptions(dataSource, statusFieldName);
        if (actual === null) {
          ctx.stderr(
            `notion_status_schema: "${statusFieldName}" property not found on the Jobs Pipeline DB (or has no select/status options). Pipeline expects: [${EXPECTED_STATUS_OPTIONS.join(", ")}]`
          );
        } else {
          const res = checkStatusSchema(actual);
          if (res.ok) {
            stdout(
              `notion_status_schema: ok (${actual.length} options present, ${EXPECTED_STATUS_OPTIONS.length} expected covered)`
            );
          } else {
            ctx.stderr(
              `notion_status_schema: missing options in Notion ${statusFieldName} select: [${res.missing.join(", ")}]. Pipeline expects all of: [${EXPECTED_STATUS_OPTIONS.join(", ")}]. Add them in Notion → ${statusFieldName} field properties.`
            );
          }
        }
      } catch (err) {
        ctx.stderr(`notion_status_schema: skipped (Notion fetch failed — ${err.message})`);
      }
    }

    // 4. Retro blocklist sweep: re-apply title/company/location blocklists to
    // existing "To Apply" rows (the only pre-apply triage state in the 8-status
    // set). Catches the case where a pattern was added to filter_rules.json
    // after old rows landed — prototype parity with validate_inbox.js. Since
    // schema v3 (G-5, 2026-05-03) TSV rows carry locations, so location
    // blocklist now exercises here too (rows without a backfilled location are
    // simply not matched against location patterns — empty array never hits).
    // Schema v5 (RFC 038, 2026-05-18) persists the full multi-element
    // locations[] array, so the BL-24 "US-anywhere wins" rule now fires
    // correctly on multi-loc rows during retro-sweep.
    //
    // L-4 (RFC 013): retro-sweep also enforces profile.geo. When profile
    // declares a metro / us-wide / remote-only mode, existing "To Apply" rows
    // whose location violates the policy are surfaced (and archived with
    // --apply). Closes G-33 as a side effect: positive geo policy now drives
    // the sweep, not just deny-lists.
    const filterRules = { ...(profile.filterRules || {}), geo: profile.geo };
    const geoActive = profile.geo && profile.geo.mode && profile.geo.mode !== "unrestricted";
    const hasBlocklistRules =
      (Array.isArray(filterRules.company_blocklist) && filterRules.company_blocklist.length > 0) ||
      (Array.isArray(filterRules.title_blocklist) && filterRules.title_blocklist.length > 0) ||
      (Array.isArray(filterRules.location_blocklist) &&
        filterRules.location_blocklist.length > 0) ||
      geoActive;
    if (appsResult.apps.length > 0 && hasBlocklistRules) {
      const matches = [];
      for (const app of appsResult.apps) {
        if (!RETRO_SWEEP_STATUSES.has(app.status)) continue;
        // v5 (RFC 038): pass the full locations[] array so the BL-24
        // "US-anywhere wins" rule fires on multi-loc rows in retro-sweep too.
        // matchBlocklists already accepts both shapes; we only emit the array.
        const reason = matchBlocklists(
          {
            company: app.companyName,
            role: app.title,
            locations: Array.isArray(app.locations) ? app.locations : [],
          },
          filterRules
        );
        if (reason) matches.push({ app, reason });
      }
      if (matches.length === 0) {
        stdout(
          `retro_sweep: ok (${appsResult.apps.filter((a) => RETRO_SWEEP_STATUSES.has(a.status)).length} rows re-screened)`
        );
      } else if (flags.apply) {
        const byKey = new Map(matches.map((m) => [m.app.key, m.reason]));
        const now = deps.now();
        const updated = appsResult.apps.map((a) =>
          byKey.has(a.key) ? { ...a, status: "Archived", updatedAt: now } : a
        );
        deps.saveApplications(path.join(profile.paths.root, "applications.tsv"), updated);
        stdout(`retro_sweep: archived ${matches.length} row(s) matching blocklists`);
        for (const m of matches.slice(0, 20)) {
          stdout(`  ARCHIVED ${m.app.companyName} — ${m.app.title} (${formatReason(m.reason)})`);
        }
        if (matches.length > 20) stdout(`  … and ${matches.length - 20} more`);
      } else {
        issues += matches.length;
        ctx.stderr(
          `retro_sweep: ${matches.length} row(s) now match blocklists (pass --apply to archive)`
        );
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
  if (reason.kind === "title_blocklist")
    return `title_blocklist: "${reason.pattern}"${reason.why ? ` — ${reason.why}` : ""}`;
  if (reason.kind === "location_blocklist") return `location_blocklist: ${reason.match}`;
  // L-4 (RFC 013): geo enforcement reasons.
  if (reason.kind === "geo_metro_miss") return `geo_metro_miss (mode: ${reason.mode || "metro"})`;
  if (reason.kind === "geo_country_miss")
    return `geo_country_miss (mode: ${reason.mode || "us-wide"})`;
  if (reason.kind === "geo_remote_only_miss") return `geo_remote_only_miss`;
  if (reason.kind === "geo_blocklist") return `geo_blocklist`;
  if (reason.kind === "geo_no_location")
    return `geo_no_location (TSV row missing location field — backfill?)`;
  return reason.kind;
}

module.exports = makeValidateCommand();
module.exports.makeValidateCommand = makeValidateCommand;
module.exports.checkCompanyCap = checkCompanyCap;
module.exports.pingUrl = pingUrl;
module.exports.pingAll = pingAll;
module.exports.isSafeLivenessUrl = isSafeLivenessUrl;
module.exports.runDedup = runDedup;
module.exports.tsvBackupPath = tsvBackupPath;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.RETRO_SWEEP_STATUSES = RETRO_SWEEP_STATUSES;
module.exports.DEFAULT_URL_CAP = DEFAULT_URL_CAP;
module.exports.DEFAULT_PING_TIMEOUT_MS = DEFAULT_PING_TIMEOUT_MS;
module.exports.DEFAULT_PING_CONCURRENCY = DEFAULT_PING_CONCURRENCY;
