#!/usr/bin/env node
// BL-236 — one-off: put the rows the night could not submit back in the queue.
//
// 1. STRONG rows stuck in Inbox. The tailoring loop ended below the target
//    coverage ("no_growth_below_threshold" / "iteration_cap_below_threshold"),
//    the row was held back and never reached To Apply. Owner decision
//    2026-11-15: submit them all the same. Each row gets its draft from the
//    saved results (profiles/<id>/prepare_results_*.json: the LAST record of
//    the key - its tailoredResume is already the best iteration of the loop
//    and its verdict is the current one), the base resume when there is no
//    draft or 0% coverage, and goes through the ordinary
//    `prepare --phase commit` (cover letter, resume PDF, Notion page through
//    pushJobPage). A row held for a real unconfirmed fact about the candidate
//    (`uncertain_about_fact` with an actual fact in the record) stays held.
//
// 2. WEAK rows in To Apply with an empty resume_ver (they died as
//    form_broken: resume_not_set). They get a resume version in place,
//    chosen without an LLM: the archetype whose title shares the most words
//    with the job title, else the archetype used most often by the profile's
//    other rows. apply_state goes back to "queued" (a "skipped" row would not
//    enter the queue). Rows skipped as no_company_form are not touched: they
//    have no form to submit to. They are NOT sent for re-evaluation: the Weak
//    verdict with a Notion page is never judged again.
//
// Default = dry-run: prints the counts and the list, writes nothing.
// --apply writes. Idempotent: a second --apply finds 0 rows.
//
// The TSV is only changed through applications_tsv under its lock, re-read
// right before the write; a row that left Inbox / To Apply meanwhile (a live
// night) is skipped. fit_evaluated_at is not moved: `commit` stamps it with
// "now", which would make `night --phase check` count the rows as prepared
// tonight, so the script puts the old value back.
//
// Usage (from the repo root, like the CLI):
//   node scripts/bl236_requeue_once.js --profile <id>
//   node scripts/bl236_requeue_once.js --profile <id> --apply

const fs = require("fs");
const path = require("path");

const SCRIPT_TAG = "bl236";
const LIST_LIMIT = 60;

function parseArgs(argv) {
  const out = {
    profile: null,
    apply: false,
    help: false,
    ignoreNightLock: false,
    profilesDir: "",
    error: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i] || null;
    else if (a === "--apply") out.apply = true;
    else if (a === "--ignore-night-lock") out.ignoreNightLock = true;
    else if (a === "--profiles-dir") out.profilesDir = argv[++i] || "";
    else if (a === "--help" || a === "-h") out.help = true;
    else out.error = `unknown argument: ${a}`;
  }
  if (!out.help && !out.error && !out.profile) out.error = "--profile <id> is required";
  return out;
}

const str = (v) => (v === undefined || v === null ? "" : String(v));

// --- Strong -------------------------------------------------------------------

// Inbox rows with a Strong verdict and no Notion page yet.
function stuckStrong(apps) {
  return (apps || []).filter(
    (a) => a && a.status === "Inbox" && a.fit_score === "Strong" && !str(a.notion_page_id).trim()
  );
}

// records: Map key → [{ file, row }] in file order (oldest first). The record
// to use is the LAST one for the key: its tailoredResume is already the best
// iteration of the loop (SKILL Step 6.5), and its verdict (e.g. a fact that
// needs the owner) is the current one - an older, better-covered record must
// not override it.
function bestRecord(list) {
  let last = null;
  for (const rec of list || []) {
    last = { ...rec, cov: Number(rec.row && rec.row.tailorCoverage) || 0 };
  }
  return last;
}

// → { eligible: [{ app, row, kind, coverage, file }], held: [{ app, why }],
//     noRecord: [app], badVersion: [app] }
// `classify` is the engine's classifyRow; `versionKeys` the profile's archetypes.
function planStrong(apps, records, { classify, versionKeys }) {
  const out = { eligible: [], held: [], noRecord: [], badVersion: [] };
  for (const app of stuckStrong(apps)) {
    const best = bestRecord(records.get(app.key));
    if (!best) {
      out.noRecord.push(app);
      continue;
    }
    const verdict = classify(best.row);
    if (verdict === "escalated") {
      out.held.push({ app, why: str(best.row.tailorEscalationReason) || "escalated" });
      continue;
    }
    if (versionKeys.size && !versionKeys.has(str(best.row.resumeVer))) {
      out.badVersion.push(app);
      continue;
    }
    out.eligible.push({ app, row: best.row, kind: verdict, coverage: best.cov, file: best.file });
  }
  return out;
}

// A cover-letter key is a file name: two rows must never share one (the
// second PDF would overwrite the first). A taken key gets the row's id.
function uniqueClKeys(entries, apps) {
  const taken = new Map(); // clKey → owner key
  for (const a of apps || []) if (str(a.cl_key)) taken.set(str(a.cl_key), a.key);
  for (const e of entries) {
    const row = e.row;
    let ck = str(row.clKey);
    if (!ck) continue;
    const owner = taken.get(ck);
    if (owner && owner !== e.app.key) {
      const tail =
        str(e.app.key)
          .replace(/[^A-Za-z0-9]+/g, "")
          .slice(-8) || "dup";
      ck = `${ck}_${tail}`;
      row.clKey = ck;
    }
    taken.set(ck, e.app.key);
  }
}

// The results entry `commit` takes: the record as it was, nothing invented.
function resultEntries(eligible) {
  return eligible.map((e) => ({ ...e.row, key: e.app.key }));
}

// --- Weak ---------------------------------------------------------------------

function isWeakWithoutResume(a) {
  return (
    a &&
    a.status === "To Apply" &&
    a.fit_score === "Weak" &&
    !str(a.resume_ver).trim() &&
    !str(a.applied_date).trim() &&
    !/^no_company_form/.test(str(a.apply_note)) &&
    // Only the two states this script cures: never tried (empty state) and
    // the failure it fixes (skipped, form_broken: resume_not_set). A row
    // skipped for any other reason (captcha, no_honest_answer, ...) is left
    // exactly as it is.
    (!str(a.apply_state).trim() ||
      (a.apply_state === "skipped" && /resume_not_set/.test(str(a.apply_note))))
  );
}

const STOP = new Set([
  "senior",
  "sr",
  "staff",
  "principal",
  "lead",
  "head",
  "group",
  "director",
  "product",
  "manager",
  "management",
  "the",
  "and",
  "for",
  "with",
  "remote",
]);

function words(s) {
  return str(s)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

// The archetype used most by the profile's other rows (only keys that are real
// archetypes with a PDF), alphabetical on a tie. null when none.
function dominantArchetype(apps, usable) {
  const counts = new Map();
  for (const a of apps || []) {
    const v = str(a.resume_ver).trim();
    if (usable.has(v)) counts.set(v, (counts.get(v) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.length ? ranked[0][0] : [...usable].sort()[0] || null;
}

// versions: resume_versions.versions; usable: Set of keys whose PDF exists.
function pickArchetype(app, versions, usable, apps) {
  const want = new Set(words(app.title));
  let best = null;
  for (const key of [...usable].sort()) {
    const v = versions[key] || {};
    const have = new Set([...words(key), ...words(v.title)]);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  if (best) return { key: best.key, why: "title match" };
  const dom = dominantArchetype(apps, usable);
  return dom ? { key: dom, why: "most used" } : null;
}

function planWeak(apps, profile, exists) {
  const versions = (profile.resumeVersions && profile.resumeVersions.versions) || {};
  const { resolveResumePdf } = require("../engine/modules/apply/resume_path.js");
  const usable = new Set(
    Object.keys(versions).filter((k) => {
      const r = resolveResumePdf({ resume_ver: k }, profile, { exists });
      return r && !r.error;
    })
  );
  const fix = [];
  const noCompanyForm = [];
  for (const a of apps || []) {
    if (a && a.status === "To Apply" && a.fit_score === "Weak" && !str(a.resume_ver).trim()) {
      if (/^no_company_form/.test(str(a.apply_note))) noCompanyForm.push(a);
    }
    if (!isWeakWithoutResume(a)) continue;
    const pick = pickArchetype(a, versions, usable, apps);
    if (pick) fix.push({ app: a, resumeVer: pick.key, why: pick.why });
  }
  return { fix, noCompanyForm };
}

// --- records on disk ----------------------------------------------------------

function readRecords(root, deps) {
  const out = new Map();
  const names = deps
    .listDir(root)
    .filter((n) => /^prepare_results_.*\.json$/.test(n))
    .sort();
  for (const name of names) {
    let data;
    try {
      data = JSON.parse(deps.readFile(path.join(root, name)));
    } catch {
      continue;
    }
    for (const row of (data && data.results) || []) {
      if (!row || !row.key || row.fitScore !== "Strong") continue;
      if (!out.has(row.key)) out.set(row.key, []);
      out.get(row.key).push({ file: name, row });
    }
  }
  return out;
}

// --- run ----------------------------------------------------------------------

function makeDefaultDeps() {
  const applicationsTsv = require("../engine/core/applications_tsv.js");
  const profileLoader = require("../engine/core/profile_loader.js");
  return {
    loadProfile: profileLoader.loadProfile,
    loadApplications: applicationsTsv.load,
    saveApplications: applicationsTsv.save,
    withLock: applicationsTsv.withLock,
    listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    writeFile: (p, d) => fs.writeFileSync(p, d),
    fileExists: (p) => fs.existsSync(p),
    classifyRow: require("../engine/modules/tailor/dispatcher.js").classifyRow,
    commit: null, // set in run(): the prepare command
    nightLockExists: (profileId, env) => {
      const { defaultStateDir } = require("../engine/commands/board.js");
      return fs.existsSync(path.join(defaultStateDir(env), profileId, "night.lock"));
    },
    now: () => new Date(),
    today: () => new Date().toISOString().slice(0, 10),
  };
}

function line(tag, app, extra) {
  return `  ${tag.padEnd(8)} ${app.key}  ${app.companyName || "?"} — ${app.title || "?"}${extra ? `  (${extra})` : ""}`;
}

async function run(opts, deps, io) {
  const env = io.env || process.env;
  const { resolveProfilesDir } = require("../engine/core/paths.js");
  const profilesDir = opts.profilesDir || resolveProfilesDir({}, env);
  const profile = deps.loadProfile(opts.profile, { profilesDir });
  const applicationsPath = profile.paths.applicationsTsv;
  const root = profile.paths.root;
  const versionKeys = new Set(
    Object.keys((profile.resumeVersions && profile.resumeVersions.versions) || {})
  );

  const { apps } = deps.loadApplications(applicationsPath);
  const records = readRecords(root, deps);
  const strong = planStrong(apps, records, { classify: deps.classifyRow, versionKeys });
  uniqueClKeys(strong.eligible, apps);
  const weak = planWeak(apps, profile, deps.fileExists);

  io.stdout(
    `bl236: Strong stuck in Inbox: ${strong.eligible.length} to requeue ` +
      `(${strong.eligible.filter((e) => e.kind === "tailored").length} with the best draft, ` +
      `${strong.eligible.filter((e) => e.kind === "archetype").length} with the base resume), ` +
      `${strong.held.length} held (unconfirmed fact), ${strong.noRecord.length} without a saved ` +
      `result, ${strong.badVersion.length} with an unknown resume version`
  );
  for (const e of strong.eligible.slice(0, LIST_LIMIT)) {
    io.stdout(line("strong", e.app, `${e.kind}, coverage ${e.coverage}%, ${e.file}`));
  }
  for (const h of strong.held) io.stdout(line("held", h.app, h.why));
  for (const a of strong.noRecord) io.stdout(line("no-rec", a));
  for (const a of strong.badVersion) io.stdout(line("bad-ver", a));
  io.stdout(
    `bl236: Weak without a resume version in To Apply: ${weak.fix.length} to fix in place, ` +
      `${weak.noCompanyForm.length} left alone (no_company_form)`
  );
  for (const f of weak.fix.slice(0, LIST_LIMIT)) {
    io.stdout(line("weak", f.app, `→ ${f.resumeVer} (${f.why})`));
  }

  if (!opts.apply) {
    io.stdout(
      strong.eligible.length + weak.fix.length
        ? "dry-run: nothing written. Re-run with --apply."
        : "dry-run: nothing to do."
    );
    return 0;
  }
  if (!strong.eligible.length && !weak.fix.length) {
    io.stdout("bl236: nothing to write.");
    return 0;
  }
  if (!opts.ignoreNightLock && deps.nightLockExists(opts.profile, env)) {
    io.stderr(
      "error: a night run holds its lock — wait for it to finish (or pass --ignore-night-lock); nothing changed"
    );
    return 1;
  }

  let code = 0;

  // Weak: resume_ver in place, under the lock, on the fresh rows.
  let weakWritten = 0;
  if (weak.fix.length) {
    const pick = new Map(weak.fix.map((f) => [f.app.key, f.resumeVer]));
    const today = deps.today();
    const nowIso = deps.now().toISOString();
    await deps.withLock(applicationsPath, () => {
      const fresh = deps.loadApplications(applicationsPath).apps;
      for (const a of fresh) {
        if (!pick.has(a.key) || !isWeakWithoutResume(a)) continue; // left the state meanwhile
        a.resume_ver = pick.get(a.key);
        if (str(a.apply_state) === "skipped") {
          a.apply_state = "queued";
          a.apply_note = `requeued:${today}`;
        }
        a.updatedAt = nowIso;
        weakWritten += 1;
      }
      if (weakWritten) deps.saveApplications(applicationsPath, fresh);
    });
    io.stdout(`bl236: Weak: ${weakWritten} row(s) got a resume version and are back in the queue.`);
  }

  // Strong: the ordinary commit, on the rows that are still in Inbox.
  if (strong.eligible.length) {
    const stillStuck = new Set(
      stuckStrong(deps.loadApplications(applicationsPath).apps).map((a) => a.key)
    );
    const go = strong.eligible.filter((e) => stillStuck.has(e.app.key));
    if (go.length < strong.eligible.length) {
      io.stderr(`  ${strong.eligible.length - go.length} row(s) left Inbox meanwhile — skipped`);
    }
    if (go.length) {
      const oldEvaluated = new Map(go.map((e) => [e.app.key, str(e.app.fit_evaluated_at)]));
      const stamp = deps
        .now()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\..*/, "")
        .replace("T", "_");
      const resultsFile = path.join(root, `prepare_results_${stamp}_${SCRIPT_TAG}.json`);
      deps.writeFile(
        resultsFile,
        JSON.stringify(
          {
            profileId: opts.profile,
            generatedAt: deps.now().toISOString(),
            companyTiers: {},
            results: resultEntries(go),
          },
          null,
          2
        )
      );
      io.stdout(`bl236: commit of ${go.length} Strong row(s) from ${path.basename(resultsFile)}`);
      const rc = await deps.commit({
        command: "prepare",
        profileId: opts.profile,
        profilesDir,
        flags: { phase: "commit", resultsFile, dryRun: false },
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      if (rc !== 0) code = rc;
      // commit stamps fit_evaluated_at with "now": put the old value back.
      const keys = new Set(oldEvaluated.keys());
      await deps.withLock(applicationsPath, () => {
        const fresh = deps.loadApplications(applicationsPath).apps;
        let n = 0;
        for (const a of fresh) {
          if (!keys.has(a.key) || a.status === "Inbox") continue;
          if (str(a.fit_evaluated_at) !== oldEvaluated.get(a.key)) {
            a.fit_evaluated_at = oldEvaluated.get(a.key);
            n += 1;
          }
        }
        if (n) deps.saveApplications(applicationsPath, fresh);
      });
      const after = deps.loadApplications(applicationsPath).apps;
      const byKey = new Map(after.map((a) => [a.key, a]));
      const ok = go.filter((e) => {
        const a = byKey.get(e.app.key);
        return (
          a &&
          a.status === "To Apply" &&
          str(a.notion_page_id) &&
          str(a.cl_path) &&
          str(a.resume_ver)
        );
      }).length;
      io.stdout(
        `bl236: Strong: ${ok} of ${go.length} row(s) are in To Apply with a page, a cover letter and a resume.`
      );
      if (ok < go.length) code = code || 1;
    }
  }
  return code;
}

async function main(argv = process.argv, io = {}) {
  const opts = parseArgs(argv);
  const out = {
    stdout: io.stdout || ((s) => process.stdout.write(`${s}\n`)),
    stderr: io.stderr || ((s) => process.stderr.write(`${s}\n`)),
    env: io.env || process.env,
  };
  if (opts.help || opts.error) {
    (opts.error ? out.stderr : out.stdout)(
      `${opts.error ? `error: ${opts.error}\n` : ""}Usage: node scripts/bl236_requeue_once.js --profile <id> [--apply] [--ignore-night-lock]`
    );
    return opts.error ? 1 : 0;
  }
  try {
    require("dotenv").config();
  } catch {
    // dotenv is optional
  }
  const deps = io.deps || makeDefaultDeps();
  if (!deps.commit) deps.commit = require("../engine/commands/prepare.js");
  return run(opts, deps, out);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  stuckStrong,
  bestRecord,
  planStrong,
  uniqueClKeys,
  resultEntries,
  isWeakWithoutResume,
  pickArchetype,
  planWeak,
  readRecords,
  run,
  main,
};
