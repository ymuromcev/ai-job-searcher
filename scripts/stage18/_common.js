// Shared helpers for Stage 18 onboarding scripts.
// Self-contained: generic CLI + Notion-script helpers used across the
// onboarding wizard. No cross-stage dependencies.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadEnv() {
  require("dotenv").config({ path: path.join(REPO_ROOT, ".env") });
}

function parseArgs(argv = process.argv.slice(2), defaults = {}) {
  const args = { profile: "jared", dryRun: true, apply: false, ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") {
      args.apply = true;
      args.dryRun = false;
    } else if (a === "--dry-run") {
      args.dryRun = true;
      args.apply = false;
    } else if (a === "--profile") {
      args.profile = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--") && a.includes("=")) {
      const [k, v] = a.slice(2).split("=");
      args[k.replace(/-/g, "_")] = v;
    } else if (a.startsWith("--")) {
      const k = a.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[k] = next;
        i += 1;
      } else {
        args[k] = true;
      }
    }
  }
  return args;
}

function requireToken(profileId) {
  const prefix = profileId.toUpperCase().replace(/-/g, "_");
  const key = `${prefix}_NOTION_TOKEN`;
  const token = process.env[key];
  if (!token) {
    console.error(`missing ${key} in .env`);
    process.exit(1);
  }
  return token;
}

function banner(title, args) {
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== ${title} [${mode}] profile=${args.profile} ===\n`);
}

function done(title, extras = {}) {
  console.log(`\n=== ${title} complete ===`);
  for (const [k, v] of Object.entries(extras)) {
    console.log(`  ${k}: ${v}`);
  }
}

function fatal(err) {
  console.error("\nFAILED:");
  console.error(err && err.body ? JSON.stringify(err.body, null, 2) : err);
  process.exit(1);
}

// Profile id: lowercase alnum + underscore, 2–32 chars.
// Refuses reserved names (_example) and anything that would collide with
// the stage16 fallback on file paths.
const PROFILE_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const RESERVED_IDS = new Set(["_example", "example", "default", "test"]);

function validateProfileId(id) {
  if (typeof id !== "string" || !id.length) {
    throw new Error("profile_id is required");
  }
  if (!PROFILE_ID_RE.test(id)) {
    throw new Error(
      `profile_id must match ${PROFILE_ID_RE} (lowercase letter/digit/underscore, 2–32 chars, starts with a letter). Got: ${JSON.stringify(id)}`
    );
  }
  if (RESERVED_IDS.has(id)) {
    throw new Error(`profile_id "${id}" is reserved`);
  }
  return id;
}

function profileDir(id) {
  return path.join(REPO_ROOT, "profiles", id);
}

function ensureStage18Dir(profileId) {
  const dir = path.join(profileDir(profileId), ".stage18");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadIntake(profileId) {
  const p = path.join(profileDir(profileId), ".stage18", "intake.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      `intake not found: ${p}\nRun parse_intake.js on the filled questionnaire first.`
    );
  }
  return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

function writeIntake(profileId, data) {
  const dir = ensureStage18Dir(profileId);
  const p = path.join(dir, "intake.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

function loadState(profileId) {
  const p = path.join(profileDir(profileId), ".stage18", "state.json");
  if (!fs.existsSync(p)) return { path: p, data: {} };
  return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

function saveState(profileId, data) {
  const dir = ensureStage18Dir(profileId);
  const p = path.join(dir, "state.json");
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

// Notion page id: dashed or undashed 32-hex. URL forms:
//   https://www.notion.so/Hub-Title-00000000000000000000000000000000
//   https://www.notion.so/00000000000000000000000000000000
//   https://www.notion.so/00000000-0000-0000-0000-000000000000
// Extract the 32-hex id. Return canonical dashed form.
function extractNotionPageId(urlOrId) {
  if (typeof urlOrId !== "string" || !urlOrId.length) {
    throw new Error("notion page URL or id is required");
  }
  // Strip URL params / fragments first.
  const cleaned = urlOrId.split("?")[0].split("#")[0];
  // Find a 32-hex run (with or without dashes).
  const m = cleaned.match(/[0-9a-fA-F]{32}/) ||
            cleaned.match(/[0-9a-fA-F-]{36}/);
  if (!m) {
    throw new Error(
      `could not extract Notion page id from ${JSON.stringify(urlOrId)}. ` +
        `Expected a 32-hex id (dashed or plain), e.g. 00000000000000000000000000000000`
    );
  }
  const raw = m[0].replace(/-/g, "");
  if (raw.length !== 32) {
    throw new Error(`invalid Notion id length after stripping dashes: ${m[0]}`);
  }
  // Canonical dashed: 8-4-4-4-12
  return (
    raw.slice(0, 8) +
    "-" +
    raw.slice(8, 12) +
    "-" +
    raw.slice(12, 16) +
    "-" +
    raw.slice(16, 20) +
    "-" +
    raw.slice(20)
  ).toLowerCase();
}

module.exports = {
  REPO_ROOT,
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  PROFILE_ID_RE,
  RESERVED_IDS,
  validateProfileId,
  profileDir,
  ensureStage18Dir,
  loadIntake,
  writeIntake,
  loadState,
  saveState,
  extractNotionPageId,
};
