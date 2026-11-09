// `companies` command (RFC 069 §6): grow the company list the scan reads.
//
//   companies add --profile <id> --ats greenhouse|lever|ashby --slug <slug>
//                 [--name <company>]
//   companies add --profile <id> --from-file <tsv>
//
// --from-file: one board per line, `ats<TAB>slug<TAB>name` (name optional;
// blank lines and "#" comments ignored). Every line is validated like the
// flags (ats in the set, slug ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$, name plain
// text) before anything is fetched; a bad line is reported as invalid and the
// others still run. This is how the night hands over boards that subagents
// found on the web: their text goes into a file, never into a shell command
// (security review L3).
//
// Used by the night's volume top-up (Round S): a subagent finds a company
// hiring matching roles on Greenhouse / Lever / Ashby and adds its board.
// The board is validated by fetching it once through the discovery adapter
// (same endpoint `scan` uses): an HTTP error or an unexpected body is
// `invalid`; a valid board with no open jobs is still added. Dedup is on
// (ats, slug) against data/companies.tsv; writes go through
// `core/companies.js` (load → append → atomic save) under a lock file, so
// parallel subagents never lose each other's rows.
//
// New rows are visible to this profile only (`profile` column). An existing
// row the profile cannot see yet gets the profile added to its list.
//
// Output: one JSON line
//   {"result":"added"|"exists"|"invalid","ats","slug","name","jobs"[,"error"]}
// Exit 0 for added / exists, 1 for invalid or bad arguments.
//
// No cap on how many companies can be added (owner decision, 09.11.2026).

const fs = require("fs");
const path = require("path");

const companiesTsv = require("../core/companies.js");
const profileLoader = require("../core/profile_loader.js");
const { resolveDataDir, resolveProfilesDir } = require("../core/paths.js");

const ATS = ["greenhouse", "lever", "ashby"];
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function boardAdapters() {
  return {
    greenhouse: require("../modules/discovery/greenhouse.js"),
    lever: require("../modules/discovery/lever.js"),
    ashby: require("../modules/discovery/ashby.js"),
  };
}

// "acme-synthetic" → "Acme Synthetic".
function nameFromSlug(slug) {
  return String(slug || "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// The body shape each board endpoint answers for a real board.
function validBoardBody(ats, body) {
  if (ats === "lever") return Array.isArray(body);
  return Boolean(body) && typeof body === "object" && Array.isArray(body.jobs);
}

// Fetch the board once through the discovery adapter. The fetchFn wrapper
// keeps the raw body so an unexpected shape (a 200 error page) is caught.
// → { ok: true, jobs } | { ok: false, error }
async function validateBoard(ats, slug, name, { fetchFn, adapters }) {
  const adapter = adapters[ats];
  if (!adapter) return { ok: false, error: `no discovery adapter for ${ats}` };
  const warnings = [];
  let body;
  let sawBody = false;
  const capture = async (url, opts) => {
    const res = await fetchFn(url, opts);
    if (!res || !res.ok || typeof res.json !== "function") return res;
    const parsed = await res.json();
    body = parsed;
    sawBody = true;
    return { ...res, ok: true, json: async () => parsed };
  };
  const jobs = await adapter.discover([{ name, slug }], {
    fetchFn: capture,
    logger: { warn: (m) => warnings.push(String(m)) },
    concurrency: 1,
  });
  if (warnings.length) {
    return { ok: false, error: warnings[0].replace(/^\[[^\]]*\]\s*/, "") };
  }
  if (!sawBody || !validBoardBody(ats, body)) {
    return { ok: false, error: "unexpected board response" };
  }
  return { ok: true, jobs: jobs.length };
}

// Exclusive lock file next to companies.tsv: core/file_lock.js (pid-based —
// a live holder is never robbed; a dead one's lock is broken).
const { withFileLock } = require("../core/file_lock.js");

function makeDefaultDeps() {
  const { defaultFetch } = require("../modules/discovery/_http.js");
  return {
    loadProfile: profileLoader.loadProfile,
    loadCompanies: companiesTsv.load,
    saveCompanies: companiesTsv.save,
    fetchFn: defaultFetch,
    adapters: boardAdapters(),
    withLock: withFileLock,
    readFile: (p) => fs.readFileSync(p, "utf8"),
  };
}

function companiesPathFor(ctx) {
  const dataDir = ctx.dataDir || path.join(resolveDataDir(ctx.env || process.env), "data");
  return path.join(dataDir, "companies.tsv");
}

function findRow(rows, ats, slug) {
  const s = String(slug).toLowerCase();
  return rows.find((r) => r.source === ats && String(r.slug).toLowerCase() === s) || null;
}

// A company name from a file or a flag: one line of plain text.
function cleanName(raw) {
  return String(raw || "")
    // eslint-disable-next-line no-control-regex -- strip control characters on purpose
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Pure. `ats\tslug\tname` lines → { entries: [{ats, slug, name, line}],
// invalid: [{line, error}] }.
function parseBoardLines(text) {
  const entries = [];
  const invalid = [];
  const seen = new Set();
  String(text || "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      if (!raw.trim() || raw.trim().startsWith("#")) return;
      const parts = raw.split("\t");
      const ats = String(parts[0] || "")
        .trim()
        .toLowerCase();
      const slug = String(parts[1] || "").trim();
      if (!ATS.includes(ats)) {
        invalid.push({ line, error: `ats must be one of ${ATS.join(", ")}` });
        return;
      }
      if (!SLUG_RE.test(slug)) {
        invalid.push({ line, error: "slug must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$" });
        return;
      }
      const k = `${ats}\t${slug.toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      entries.push({ ats, slug, name: cleanName(parts.slice(2).join(" ")), line });
    });
  return { entries, invalid };
}

async function runAdd(ctx, deps) {
  const { profileId, flags, stderr } = ctx;
  if (flags.fromFile) return runAddFromFile(ctx, deps);
  const ats = String(flags.ats || "")
    .trim()
    .toLowerCase();
  const slug = String(flags.slug || "").trim();
  if (!ATS.includes(ats)) {
    stderr(`error: --ats must be one of ${ATS.join(", ")}`);
    return 1;
  }
  if (!SLUG_RE.test(slug)) {
    stderr("error: --slug <slug> is required (letters, digits, . _ -)");
    return 1;
  }
  // Validates the profile id and that the profile exists.
  deps.loadProfile(profileId, { profilesDir: resolveProfilesDir(ctx, ctx.env || process.env) });
  return addOne(ctx, deps, { ats, slug, name: cleanName(flags.name) });
}

async function runAddFromFile(ctx, deps) {
  const { profileId, flags, stdout, stderr } = ctx;
  let text;
  try {
    text = deps.readFile(String(flags.fromFile));
  } catch (err) {
    stderr(`error: cannot read --from-file ${flags.fromFile}: ${err.message}`);
    return 1;
  }
  deps.loadProfile(profileId, { profilesDir: resolveProfilesDir(ctx, ctx.env || process.env) });
  const { entries, invalid } = parseBoardLines(text);
  for (const bad of invalid) {
    stdout(JSON.stringify({ result: "invalid", line: bad.line, error: bad.error }));
  }
  const tally = { added: 0, exists: 0, invalid: invalid.length };
  for (const e of entries) {
    await addOne(ctx, deps, e, (obj) => {
      if (tally[obj.result] !== undefined) tally[obj.result] += 1;
    });
  }
  stderr(
    `companies add --from-file: ${tally.added} added, ${tally.exists} already known, ` +
      `${tally.invalid} invalid`
  );
  return 0;
}

// Add one board (ats + slug already validated).
async function addOne(ctx, deps, { ats, slug, name: rawName }, onResult = () => {}) {
  const { profileId, stdout, stderr } = ctx;
  const name = rawName || nameFromSlug(slug);

  const companiesPath = companiesPathFor(ctx);
  const emit = (obj) => {
    onResult(obj);
    stdout(JSON.stringify(obj));
  };

  const { rows } = deps.loadCompanies(companiesPath);
  const known = findRow(rows, ats, slug);
  if (known && companiesTsv.rowVisibleToProfile(known, profileId)) {
    emit({ result: "exists", ats, slug: known.slug, name: known.name, jobs: null });
    return 0;
  }

  const check = await validateBoard(ats, slug, (known && known.name) || name, {
    fetchFn: deps.fetchFn,
    adapters: deps.adapters,
  });
  if (!check.ok) {
    emit({ result: "invalid", ats, slug, name, jobs: 0, error: check.error });
    return 1;
  }

  // Re-read under the lock: another subagent may have written meanwhile.
  return deps.withLock(`${companiesPath}.lock`, async () => {
    const fresh = deps.loadCompanies(companiesPath).rows;
    const row = findRow(fresh, ats, slug);
    if (row && companiesTsv.rowVisibleToProfile(row, profileId)) {
      emit({ result: "exists", ats, slug: row.slug, name: row.name, jobs: check.jobs });
      return 0;
    }
    if (row) {
      // Owned by other profile(s): share it with this one too.
      row.profile = [row.profile, profileId].filter(Boolean).join(",");
      deps.saveCompanies(companiesPath, fresh);
      emit({
        result: "exists",
        ats,
        slug: row.slug,
        name: row.name,
        jobs: check.jobs,
        shared_with_profile: true,
      });
      return 0;
    }
    fresh.push({ name, source: ats, slug, extra: null, profile: profileId });
    deps.saveCompanies(companiesPath, fresh);
    emit({ result: "added", ats, slug, name, jobs: check.jobs });
    if (check.jobs === 0) stderr(`note: ${ats}:${slug} is a valid board with no open jobs`);
    return 0;
  });
}

function makeCompaniesCommand(overrides = {}) {
  return async function companiesCommand(ctx) {
    const deps = { ...makeDefaultDeps(), ...overrides };
    const sub = ctx.subcommand || "";
    if (sub === "add") return runAdd(ctx, deps);
    ctx.stderr(`error: companies needs a subcommand: add (got "${sub}")`);
    return 1;
  };
}

module.exports = makeCompaniesCommand();
module.exports.makeCompaniesCommand = makeCompaniesCommand;
module.exports.validateBoard = validateBoard;
module.exports.nameFromSlug = nameFromSlug;
module.exports.withFileLock = withFileLock;
module.exports.parseBoardLines = parseBoardLines;
