// Cross-reference checks for a normalized profile. Only check that touches
// the filesystem. Pure helpers are split out so the unit tests can inject
// `deps` (fs reads, companies-tsv loader) without going to disk.
//
// See RFC 037 §3.3.
//
//   { severity, category: "referential", field, message }

const fs = require("fs");
const path = require("path");

function issue(severity, field, message) {
  return { severity, category: "referential", field, message };
}

const DEFAULT_DEPS = {
  existsSync: (p) => fs.existsSync(p),
  loadCompanies: null, // resolved lazily — keeps test isolation cleaner
};

function getCompaniesLoader() {
  // Lazy require so a test-time mock can replace it cleanly.
  // eslint-disable-next-line global-require
  return require("../../companies.js").load;
}

function checkModules(profile, opts, deps, issues) {
  const modules = Array.isArray(profile && profile.modules) ? profile.modules : [];
  const modulesDir =
    opts.modulesDir || path.resolve(process.cwd(), "engine", "modules", "discovery");
  for (let i = 0; i < modules.length; i += 1) {
    const m = modules[i];
    const base = `profile.modules[${i}]`;
    if (typeof m !== "string") {
      issues.push(issue("error", base, "entry must be a string"));
      continue;
    }
    // Only `discovery:<name>` is checked here — other module namespaces
    // (e.g. `generators:resume_pdf`) live elsewhere; out of scope until
    // they grow file-based plugins too.
    const match = /^discovery:([a-z0-9_]+)$/.exec(m);
    if (!match) continue;
    const name = match[1];
    const expected = path.join(modulesDir, `${name}.js`);
    if (!deps.existsSync(expected)) {
      issues.push(
        issue(
          "error",
          base,
          `discovery adapter "${name}" not found at ${expected} (add the file or remove the module entry)`
        )
      );
    }
  }
}

function checkProfileFiles(profile, opts, deps, issues) {
  const root = opts.profileRoot || (profile && profile.paths && profile.paths.root);
  if (!root) return;
  const resume = profile && profile.resume;
  if (resume && typeof resume === "object" && resume.versions_file) {
    const p = path.join(root, resume.versions_file);
    if (!deps.existsSync(p)) {
      issues.push(
        issue(
          "error",
          "profile.resume.versions_file",
          `file not found: ${resume.versions_file} (resolved to ${p})`
        )
      );
    }
  }
  const cl = profile && profile.cover_letter;
  if (cl && typeof cl === "object") {
    if (cl.template_file) {
      const p = path.join(root, cl.template_file);
      if (!deps.existsSync(p)) {
        issues.push(
          issue(
            "error",
            "profile.cover_letter.template_file",
            `file not found: ${cl.template_file} (resolved to ${p})`
          )
        );
      }
    }
    if (cl.config_file) {
      const p = path.join(root, cl.config_file);
      if (!deps.existsSync(p)) {
        issues.push(
          issue(
            "error",
            "profile.cover_letter.config_file",
            `file not found: ${cl.config_file} (resolved to ${p})`
          )
        );
      }
    }
  }
}

function checkCompaniesBlacklist(profile, opts, deps, issues) {
  const discovery = profile && profile.discovery;
  if (!discovery || !Array.isArray(discovery.companies_blacklist)) return;
  const list = discovery.companies_blacklist;
  if (list.length === 0) return;
  const companiesTsv = path.join(
    opts.dataDir || path.resolve(process.cwd(), "data"),
    "companies.tsv"
  );
  // RFC 037 §3.3: data/companies.tsv is gitignored, so absence shouldn't
  // hard-fail validate on a fresh clone. Skip the check (no warn) — the
  // operator hasn't seeded the pool yet.
  if (!deps.existsSync(companiesTsv)) return;
  let rows;
  try {
    const loader = deps.loadCompanies || getCompaniesLoader();
    const result = loader(companiesTsv);
    rows = result && result.rows ? result.rows : [];
  } catch (err) {
    issues.push(
      issue(
        "warn",
        "profile.discovery.companies_blacklist",
        `could not read ${companiesTsv} to cross-check entries: ${err.message}`
      )
    );
    return;
  }
  const knownNames = new Set(
    rows.map((r) => (r && typeof r.name === "string" ? r.name.toLowerCase() : null)).filter(Boolean)
  );
  list.forEach((entry, i) => {
    if (typeof entry !== "string") return;
    const lc = entry.toLowerCase();
    if (!knownNames.has(lc)) {
      issues.push(
        issue(
          "warn",
          `profile.discovery.companies_blacklist[${i}]`,
          `"${entry}" not found in data/companies.tsv (typo?)`
        )
      );
    }
  });
}

function runReferentialChecks(profile, options = {}, depsOverrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...depsOverrides };
  const issues = [];
  if (!profile || typeof profile !== "object") return issues;
  checkModules(profile, options, deps, issues);
  checkProfileFiles(profile, options, deps, issues);
  checkCompaniesBlacklist(profile, options, deps, issues);
  return issues;
}

module.exports = {
  runReferentialChecks,
};
