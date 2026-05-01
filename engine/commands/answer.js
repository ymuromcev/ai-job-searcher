// `answer` command — three-phase application Q&A flow.
//
// Per RFC 009 — Notion Application Q&A integration.
//
// Phase `search`:
//   Inputs: --company, --role, --question
//   Output: JSON to stdout with { key, exact, partials, schema, category_suggestion }
//   Used by the SKILL to decide reuse vs. regenerate before generation.
//
// Phase `push`:
//   Input: --results-file pointing to a draft JSON written by the SKILL.
//   Action:
//     - If draft.existingPageId is set → update Answer/Category/Notes on that page.
//     - Otherwise → create a new page in profile.notion.application_qa_db_id.
//     - Write a local .md backup to profiles/<id>/application_answers/.
//   Output: JSON { pageId, action: "created"|"updated", url, backupPath }.
//
// The factory `makeAnswerCommand({ deps })` is exported so tests can inject
// fakes for the Notion client and filesystem.

const path = require("path");
const fs = require("fs");

const profileLoader = require("../core/profile_loader.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { makeClient } = require("../core/notion_sync.js");
const {
  searchAnswers,
  createAnswerPage,
  updateAnswerPage,
} = require("../core/qa_notion.js");
const { dedupKey } = require("../core/qa_dedup.js");
const { categorize, CATEGORIES } = require("../core/qa_categorize.js");

// --- helpers -----------------------------------------------------------------

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function backupFilename({ company, role, dateStamp = todayStamp() }) {
  const co = String(company || "unknown").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const rs = slugify(role) || "role";
  return `${co || "unknown"}_${rs}_${dateStamp}.md`;
}

function nextAvailableBackupPath(dir, baseFilename, fsImpl = fs) {
  const full = path.join(dir, baseFilename);
  if (!fsImpl.existsSync(full)) return full;
  // Append _vN until we find an unused filename.
  const dot = baseFilename.lastIndexOf(".");
  const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot);
  const ext = dot === -1 ? "" : baseFilename.slice(dot);
  for (let n = 2; n < 100; n++) {
    const candidate = path.join(dir, `${stem}_v${n}${ext}`);
    if (!fsImpl.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find available backup filename for ${baseFilename}`);
}

function buildBackupMarkdown(draft) {
  const charCount = String(draft.answer || "").length;
  const stamp = new Date().toISOString();
  return [
    `# ${draft.company} — ${draft.role}`,
    "",
    `- **Date saved**: ${stamp}`,
    `- **Role**: ${draft.role}`,
    `- **Status**: ${draft.existingPageId ? "updated" : "submitted"}`,
    draft.category ? `- **Category**: ${draft.category}` : null,
    draft.notes ? `- **Notes**: ${draft.notes}` : null,
    "",
    "---",
    "",
    `## Q. ${draft.question}`,
    "",
    String(draft.answer || ""),
    "",
    `_(${charCount} chars)_`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function validateDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== "object") {
    return ["draft must be an object"];
  }
  for (const f of ["company", "role", "question", "answer"]) {
    if (typeof draft[f] !== "string" || !draft[f].trim()) {
      errors.push(`missing required field: ${f}`);
    }
  }
  if (draft.category != null && !CATEGORIES.includes(draft.category)) {
    errors.push(`invalid category: ${draft.category} (allowed: ${CATEGORIES.join(", ")})`);
  }
  if (
    draft.existingPageId != null &&
    (typeof draft.existingPageId !== "string" || !draft.existingPageId.trim())
  ) {
    errors.push(
      "existingPageId must be a non-empty string when present"
    );
  }
  if (draft.notes != null && typeof draft.notes !== "string") {
    errors.push("notes must be a string when present");
  }
  return errors;
}

// --- deps factory ------------------------------------------------------------

function makeDefaultDeps() {
  return {
    loadProfile: profileLoader.loadProfile,
    loadSecrets: profileLoader.loadSecrets,
    makeClient,
    searchAnswers,
    createAnswerPage,
    updateAnswerPage,
    fs,
    resolveProfilesDir,
    now: () => new Date(),
  };
}

// --- Phase: search -----------------------------------------------------------

async function runSearch(ctx, deps) {
  const { profileId, flags, env, stdout, stderr } = ctx;
  const company = (flags.company || "").trim();
  const role = (flags.role || "").trim();
  const question = (flags.question || "").trim();
  if (!company || !role || !question) {
    stderr("error: --phase search requires --company, --role, and --question");
    return 1;
  }

  const profile = deps.loadProfile(profileId);
  const dbId =
    profile && profile.notion && profile.notion.application_qa_db_id;
  if (!dbId) {
    stderr(
      `error: profile "${profileId}" has no notion.application_qa_db_id configured`
    );
    return 1;
  }

  const secrets = deps.loadSecrets(profileId, env);
  const token = secrets.NOTION_TOKEN;
  if (!token) {
    stderr(
      `error: missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")} env var`
    );
    return 1;
  }

  const client = deps.makeClient(token);
  const { exact, partials } = await deps.searchAnswers(client, dbId, {
    company,
    role,
    question,
  });

  const out = {
    key: dedupKey({ company, role, question }),
    exact: exact || null,
    partials: partials || [],
    schema: { categories: CATEGORIES },
    category_suggestion: categorize(question),
  };
  stdout(JSON.stringify(out, null, 2));
  return 0;
}

// --- Phase: push -------------------------------------------------------------

async function runPush(ctx, deps) {
  const { profileId, flags, env, stdout, stderr } = ctx;
  const resultsFile = (flags.resultsFile || "").trim();
  if (!resultsFile) {
    stderr("error: --phase push requires --results-file <path>");
    return 1;
  }
  const absResults = path.isAbsolute(resultsFile)
    ? resultsFile
    : path.resolve(process.cwd(), resultsFile);
  if (!deps.fs.existsSync(absResults)) {
    stderr(`error: results file not found: ${absResults}`);
    return 1;
  }

  let draft;
  try {
    draft = JSON.parse(deps.fs.readFileSync(absResults, "utf8"));
  } catch (e) {
    stderr(`error: failed to parse results file as JSON: ${e.message}`);
    return 1;
  }

  const errors = validateDraft(draft);
  if (errors.length) {
    stderr(`error: invalid draft: ${errors.join("; ")}`);
    return 1;
  }

  const profile = deps.loadProfile(profileId);
  const dbId =
    profile && profile.notion && profile.notion.application_qa_db_id;
  if (!dbId) {
    stderr(
      `error: profile "${profileId}" has no notion.application_qa_db_id configured`
    );
    return 1;
  }

  const secrets = deps.loadSecrets(profileId, env);
  const token = secrets.NOTION_TOKEN;
  if (!token) {
    stderr(
      `error: missing ${profileLoader.secretEnvName(profileId, "NOTION_TOKEN")} env var`
    );
    return 1;
  }

  const client = deps.makeClient(token);

  const fields = {
    question: draft.question,
    answer: draft.answer,
    category: draft.category || null,
    role: draft.role,
    company: draft.company,
    notes: draft.notes || "",
  };

  // Write local .md backup BEFORE the Notion call so a Notion failure leaves
  // a recoverable artifact on disk. If backup write fails (full disk, EACCES),
  // surface that error and skip the Notion push entirely — better to fail
  // closed than create a Notion row with no local record.
  const profilesDir = deps.resolveProfilesDir();
  const backupDir = path.join(profilesDir, profileId, "application_answers");
  if (!deps.fs.existsSync(backupDir)) {
    deps.fs.mkdirSync(backupDir, { recursive: true });
  }
  const baseName = backupFilename({
    company: draft.company,
    role: draft.role,
    dateStamp: todayStamp(),
  });
  const backupPath = nextAvailableBackupPath(backupDir, baseName, deps.fs);
  deps.fs.writeFileSync(backupPath, buildBackupMarkdown(draft), "utf8");

  let action, page;
  try {
    if (draft.existingPageId) {
      page = await deps.updateAnswerPage(client, draft.existingPageId, {
        answer: fields.answer,
        category: fields.category,
        notes: fields.notes,
      });
      action = "updated";
    } else {
      page = await deps.createAnswerPage(client, dbId, fields);
      action = "created";
    }
  } catch (e) {
    stderr(
      `error: notion push failed: ${e.message}. Local backup preserved at ${path.relative(
        process.cwd(),
        backupPath
      )}`
    );
    return 1;
  }

  const out = {
    pageId: (page && page.id) || draft.existingPageId,
    action,
    url: (page && page.url) || null,
    backupPath: path.relative(process.cwd(), backupPath),
  };
  stdout(JSON.stringify(out, null, 2));
  return 0;
}

// --- factory + export --------------------------------------------------------

function makeAnswerCommand(overrides = {}) {
  const deps = { ...makeDefaultDeps(), ...overrides };

  return async function answerCommand(ctx) {
    const phase = (ctx.flags && ctx.flags.phase) || "";
    if (phase === "search") return runSearch(ctx, deps);
    if (phase === "push") return runPush(ctx, deps);
    ctx.stderr("error: --phase <search|push> is required for the answer command");
    return 1;
  };
}

module.exports = makeAnswerCommand();
module.exports.makeAnswerCommand = makeAnswerCommand;
module.exports.buildBackupMarkdown = buildBackupMarkdown;
module.exports.backupFilename = backupFilename;
module.exports.nextAvailableBackupPath = nextAvailableBackupPath;
module.exports.slugify = slugify;
module.exports.validateDraft = validateDraft;
