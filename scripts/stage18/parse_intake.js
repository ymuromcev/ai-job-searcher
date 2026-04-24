// parse_intake.js — markdown intake questionnaire → structured JSON.
//
// Template: scripts/stage18/intake_template.md. Ten sections A–K.
// Parser is lenient: empty values are omitted, RU/EN values pass through,
// "yes"/"no"/"да"/"нет" normalized to booleans, numbers parsed, comma lists
// split.
//
// Output shape is documented in scripts/stage18/README.md §intake-shape.

const fs = require("fs");

// Known sections — we key by letter so the parser doesn't depend on the
// human-readable name. Maps to output-json top-level keys.
const SECTION_MAP = {
  A: "identity",
  B: "career",
  C: "preferences",
  D: "companies",
  E: "resume_archetypes", // special-cased (sub-sections)
  F: "cover_letter",
  G: "notion",
  H: "modules", // special-cased (list of module strings)
  I: "env_checks",
  J: "prototype",
  K: "flags",
};

// Fields we want as numbers (if present and parseable).
const NUMBER_FIELDS = new Set([
  "years_experience",
  "salary_min_total_comp",
  "salary_ideal_total_comp",
]);

// Fields we want as booleans (yes/no/true/false/да/нет).
const BOOL_FIELDS = new Set([
  "integration_shared",
  "env_notion_token_set",
  "env_usajobs_set",
  "has_prototype",
  "import_cover_letter_template",
  "import_resume_versions",
  "import_cover_letter_versions",
  "import_generated_cover_letters",
  "import_generated_resumes",
  "import_tsv",
  "watcher_enabled",
  "include_companies_seed",
]);

// Fields where a single line is actually a comma-separated list.
const COMMA_LIST_FIELDS = new Set([
  "company_sizes_ok",
  "tags",
]);

function toBool(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (["yes", "y", "true", "да", "+"].includes(v)) return true;
  if (["no", "n", "false", "нет", "-"].includes(v)) return false;
  return null;
}

function stripComments(md) {
  // Strip HTML comments — our template uses them for inline hints.
  return md.replace(/<!--[\s\S]*?-->/g, "");
}

function isSkipValue(v) {
  if (v === null || v === undefined) return true;
  const t = String(v).trim().toLowerCase();
  return t === "" || t === "(skip)" || t === "skip" || t === "—" || t === "-";
}

// Tokenize the markdown into section/subsection/line events.
// This is the source-of-truth walk the folders below operate on.
function tokenize(md) {
  const lines = stripComments(md).split("\n");
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const section = line.match(/^##\s+([A-Z])\.\s+(.+?)\s*$/);
    if (section) {
      events.push({ kind: "section", letter: section[1], name: section[2], lineno: i + 1 });
      continue;
    }
    const subsection = line.match(/^###\s+([A-Z])\.(\d+)\s+(.+?)\s*$/);
    if (subsection) {
      events.push({
        kind: "subsection",
        letter: subsection[1],
        index: parseInt(subsection[2], 10),
        slug: subsection[3].trim(),
        lineno: i + 1,
      });
      continue;
    }
    // Top-level h1 — ignore.
    if (/^#\s+/.test(line)) continue;
    events.push({ kind: "line", text: line, lineno: i + 1 });
  }
  return events;
}

// Within a section body, group lines into (key, value|list) pairs.
// Rules:
//   "- key: value"   → scalar
//   "- key:"         → starts list; subsequent "  - item" lines feed it
//                       until the next key or section boundary.
// Unknown lines (blank / prose) are ignored.
function foldSectionLines(lines) {
  const out = {};
  let currentListKey = null;
  for (const line of lines) {
    const text = line.text;
    const kvMatch = text.match(/^\s*-\s+([a-z][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2];
      if (val.trim() === "") {
        // Start of a list OR empty scalar. Treat as list; if no bullets
        // follow, we'll end up with an empty array → discard later.
        out[key] = [];
        currentListKey = key;
      } else {
        out[key] = val.trim();
        currentListKey = null;
      }
      continue;
    }
    const bulletMatch = text.match(/^\s+-\s+(.*)$/);
    if (bulletMatch && currentListKey) {
      const item = bulletMatch[1].trim();
      if (!isSkipValue(item)) {
        out[currentListKey].push(item);
      }
      continue;
    }
    // Anything else: if it's not blank and there's no active key, ignore.
    // If it's blank, it breaks the bullet list context.
    if (text.trim() === "") currentListKey = null;
  }
  return out;
}

// Coerce scalars per-field: numbers / bools. Leaves strings as-is.
// Arrays are left alone (list membership already cleaned by fold).
function coerceFields(section, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      // Empty list → drop. Non-empty → keep.
      if (v.length) out[k] = v;
      continue;
    }
    if (isSkipValue(v)) continue;
    if (BOOL_FIELDS.has(k)) {
      const b = toBool(v);
      if (b !== null) out[k] = b;
      continue;
    }
    if (NUMBER_FIELDS.has(k)) {
      const n = Number(String(v).replace(/[, _$]/g, ""));
      if (Number.isFinite(n)) out[k] = n;
      continue;
    }
    if (COMMA_LIST_FIELDS.has(k)) {
      const items = String(v)
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length && !isSkipValue(x));
      if (items.length) out[k] = items;
      continue;
    }
    out[k] = String(v).trim();
  }
  return out;
}

function parseSectionE(events) {
  // Resume archetypes: a list of subsections, each with its own fields.
  const archetypes = [];
  let current = null;
  for (const ev of events) {
    if (ev.kind === "subsection") {
      if (current) archetypes.push(current);
      current = { key: ev.slug, _lines: [] };
      continue;
    }
    if (ev.kind === "line" && current) {
      current._lines.push(ev);
    }
  }
  if (current) archetypes.push(current);
  // Coerce each archetype's fields. `bullets` and `tags` are special:
  // bullets → list (folded already); tags → comma-list.
  const result = [];
  for (const a of archetypes) {
    const folded = foldSectionLines(a._lines);
    const coerced = coerceFields("E", folded);
    // Drop the template placeholder "<key>" if user didn't rename it.
    if (a.key === "<key>" || a.key.startsWith("<") || !a.key) continue;
    // Require at least one meaningful field beyond the slug.
    const meaningful = Object.keys(coerced).some(
      (k) => k !== "key" && coerced[k] !== undefined
    );
    if (!meaningful) continue;
    result.push({ key: a.key, ...coerced });
  }
  return result;
}

function parseSectionH(events) {
  // Modules: a single `- modules:` list with one module string per bullet.
  // Tolerate lines that start with "#" (commented out).
  const modules = [];
  let active = false;
  for (const ev of events) {
    if (ev.kind !== "line") continue;
    const text = ev.text;
    if (/^\s*-\s+modules\s*:/.test(text)) {
      active = true;
      continue;
    }
    if (!active) continue;
    const m = text.match(/^\s+-\s+(discovery:[a-z0-9_]+)\s*$/i);
    if (m) modules.push(m[1].toLowerCase());
  }
  return modules;
}

function parseIntake(md) {
  if (typeof md !== "string" || !md.length) {
    throw new Error("parseIntake: input must be a non-empty string");
  }
  const events = tokenize(md);

  // Group events by section.
  const bySection = {}; // letter -> { name, events: [] }
  let current = null;
  for (const ev of events) {
    if (ev.kind === "section") {
      current = { name: ev.name, events: [] };
      bySection[ev.letter] = current;
      continue;
    }
    if (current) current.events.push(ev);
  }

  const result = {};
  for (const [letter, outKey] of Object.entries(SECTION_MAP)) {
    const sec = bySection[letter];
    if (!sec) continue;
    if (letter === "E") {
      result[outKey] = parseSectionE(sec.events);
      continue;
    }
    if (letter === "H") {
      result[outKey] = parseSectionH(sec.events);
      continue;
    }
    const lines = sec.events.filter((e) => e.kind === "line");
    const folded = foldSectionLines(lines);
    result[outKey] = coerceFields(letter, folded);
  }

  return result;
}

// Required-field check — lightweight, consumed by deploy_profile.js step 0.
// Returns { ok, errors: [...] }.
function validateIntake(intake) {
  const errors = [];
  const identity = intake.identity || {};
  if (!identity.profile_id) errors.push("identity.profile_id is required");
  if (!identity.full_name) errors.push("identity.full_name is required");
  if (!identity.email) errors.push("identity.email is required");

  const notion = intake.notion || {};
  if (!notion.parent_page_url) errors.push("notion.parent_page_url is required");

  const archetypes = intake.resume_archetypes || [];
  if (!archetypes.length) {
    errors.push("at least one resume archetype (section E) is required");
  }

  const envs = intake.env_checks || {};
  if (envs.env_notion_token_set !== true) {
    errors.push(
      "env_checks.env_notion_token_set must be yes — confirm <PROFILE_ID_UPPER>_NOTION_TOKEN is in .env"
    );
  }

  return { ok: errors.length === 0, errors };
}

// CLI entrypoint. Usage:
//   node parse_intake.js --profile pat --input intake_filled.md [--apply]
// Default: prints parsed JSON to stdout. --apply writes to
// profiles/<id>/.stage18/intake.json + backs up the markdown source.
async function main() {
  const { loadEnv, parseArgs, banner, done, fatal } = require("./_common.js");
  const { writeIntake, ensureStage18Dir, validateProfileId } = require("./_common.js");
  const path = require("path");
  loadEnv();
  const args = parseArgs();
  banner("parse_intake", args);

  if (!args.input) {
    fatal(new Error("--input <path-to-filled-intake.md> is required"));
  }
  const md = fs.readFileSync(args.input, "utf8");
  const intake = parseIntake(md);
  const { ok, errors } = validateIntake(intake);

  if (errors.length) {
    console.error("  validation issues:");
    for (const e of errors) console.error("    - " + e);
  }
  console.log(JSON.stringify(intake, null, 2));

  if (!ok) {
    console.error("  intake has required-field errors. Fix and re-run.");
    process.exit(1);
  }

  if (!args.apply) {
    console.log("  (dry-run — pass --apply to persist to profiles/<id>/.stage18/)");
    done("parse_intake");
    return;
  }

  const id = validateProfileId(intake.identity.profile_id);
  if (args.profile && args.profile !== id && args.profile !== "jared") {
    // CLI --profile override is advisory; intake is source of truth.
    console.warn(
      `  --profile=${args.profile} overridden by intake.identity.profile_id=${id}`
    );
  }
  ensureStage18Dir(id);
  const intakePath = writeIntake(id, intake);
  const mdBackup = path.join(path.dirname(intakePath), "intake.md.backup");
  fs.writeFileSync(mdBackup, md);
  console.log(`  wrote ${intakePath}`);
  console.log(`  backup ${mdBackup}`);
  done("parse_intake", { profile_id: id });
}

if (require.main === module) {
  main().catch(require("./_common.js").fatal);
}

module.exports = {
  parseIntake,
  validateIntake,
  tokenize,
  foldSectionLines,
  coerceFields,
  toBool,
  isSkipValue,
  SECTION_MAP,
};
