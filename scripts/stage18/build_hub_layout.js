// Stage 18 — generic hub layout builder.
//
// Canonical deployment target for ALL profiles: the shape of Jared's original
// prototype hub (Intro → Candidate Profile inline → 3-col (📥 callout |
// Playbooks | Databases) → divider → Jobs Pipeline → sentinel). This script
// REPLACES scripts/stage16/build_hub_layout.js for new deployments but is
// backward-compatible with it: if a stage16 sentinel (`hub-layout-v1`) is
// already on the page, we treat the main layout as complete and only back-fill
// empty subpages (stage16 left Candidate Profile + Workflow empty).
//
// Inputs: profiles/<id>/profile.json (identity, company_tiers, preferences,
// notion.{workspace_page_id, *_db_id}).
//
// Idempotency:
//   • Main layout guarded by HUB_LAYOUT_SENTINEL in the hub body.
//   • Each subpage gets its own `⟡ stage18-<key>-v1` sentinel at the bottom
//     of the body, so re-runs skip already-populated subpages and only fill
//     the empty ones left by stage16.
//
// Usage:
//   node scripts/stage18/build_hub_layout.js --profile jared            # dry-run
//   node scripts/stage18/build_hub_layout.js --profile jared --apply

const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

const {
  REPO_ROOT,
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  loadState,
  saveState,
  validateProfileId,
} = require("./_common.js");

// Helpers duplicated here so stage18 is self-contained (stage16 migration
// scripts are not shipped in the public release).
function indexExistingChildPages(children) {
  const byTitle = new Map();
  for (const block of children) {
    if (block.type === "child_page") {
      const title = block.child_page && block.child_page.title;
      if (title) byTitle.set(title, block.id);
    }
  }
  return byTitle;
}

function hasColumnList(children) {
  return children.some((b) => b.type === "column_list");
}

function paragraphText(block) {
  if (!block || block.type !== "paragraph") return "";
  const rt = (block.paragraph && block.paragraph.rich_text) || [];
  return rt.map((t) => t.plain_text || (t.text && t.text.content) || "").join("");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Subpage titles are in Russian for the user-facing tabs (the user's working
// language is Russian; the surrounding workspace UI is too). Keys stay
// English/snake_case — they're stable identifiers used in profile.json,
// state.json, and tests; renaming them would force a migration.
//
// LEGACY_TITLES lets us recognize subpages created before the rename so we
// can rename them in-place via pages.update instead of creating duplicates.
const SUBPAGES = [
  { key: "candidate_profile", title: "Candidate Profile", icon: "👤", mode: "candidate_profile" },
  { key: "workflow", title: "Воркфлоу", icon: "⚙️", mode: "workflow" },
  { key: "target_tier", title: "Тиры компаний", icon: "🎯", mode: "target_tier" },
  { key: "resume_versions", title: "Версии резюме", icon: "📌", mode: "resume_versions" },
];

const LEGACY_TITLES = {
  workflow: ["Workflow"],
  target_tier: ["Target Tier"],
  resume_versions: ["Resume Versions"],
};

const HUB_LAYOUT_SENTINEL = "⟡ hub-layout-v1 (managed by scripts/stage18/build_hub_layout.js)";

// Accept either stage16 or stage18 sentinel — both use the same "hub-layout-v1"
// marker so we don't re-append on a profile where stage16 already ran.
function hasHubLayoutSentinelV1(children) {
  return children.some((b) => paragraphText(b).includes("hub-layout-v1"));
}

function subpageSentinel(key) {
  return `⟡ stage18-${key}-v1`;
}

// ---------------------------------------------------------------------------
// Block builders (duplicated from stage16 for independence)
// ---------------------------------------------------------------------------

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading2(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function heading3(text) {
  return {
    object: "block",
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function bullet(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function divider() {
  return { object: "block", type: "divider", divider: {} };
}

function callout(text, emoji = "📥") {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: text } }],
      icon: { type: "emoji", emoji },
      color: "gray_background",
    },
  };
}

// Callout variant that accepts rich-text segments (mix of plain + bold + code).
// Same shape as `callout` but driven by `richText(segments)` instead of a
// single string, so we can highlight `--profile <id>` inline.
function calloutRich(segments, emoji = "💡", color = "blue_background") {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: richText(segments),
      icon: { type: "emoji", emoji },
      color,
    },
  };
}

function linkToPage(id, kind = "page_id") {
  return {
    object: "block",
    type: "link_to_page",
    link_to_page:
      kind === "database_id"
        ? { type: "database_id", database_id: id }
        : { type: "page_id", page_id: id },
  };
}

// Inline rich_text with optional bold segments. `segments` is an array of
// either plain strings or { text, bold } objects.
function richText(segments) {
  if (typeof segments === "string") {
    return [{ type: "text", text: { content: segments } }];
  }
  return segments.map((s) => {
    if (typeof s === "string") return { type: "text", text: { content: s } };
    const annotations = {};
    if (s.bold) annotations.bold = true;
    if (s.code) annotations.code = true;
    const node = { type: "text", text: { content: s.text } };
    if (Object.keys(annotations).length) node.annotations = annotations;
    return node;
  });
}

function paragraphRich(segments) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richText(segments) },
  };
}

function bulletRich(segments) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: richText(segments) },
  };
}

// Build a Notion table block.
// `rows` is an array of arrays of cells; each cell is either a string or a
// richText-style segment array.
function table(rows, { hasHeader = true } = {}) {
  if (!rows.length) throw new Error("table: rows empty");
  const width = rows[0].length;
  return {
    object: "block",
    type: "table",
    table: {
      table_width: width,
      has_column_header: hasHeader,
      has_row_header: false,
      children: rows.map((cells) => ({
        object: "block",
        type: "table_row",
        table_row: {
          cells: cells.map((c) => richText(c)),
        },
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Subpage bodies
// ---------------------------------------------------------------------------

// Split a comma/semicolon/newline separated list into trimmed non-empty items.
function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCandidateProfileBlocks(profile) {
  const identity = profile.identity || {};
  const prefs = profile.preferences || {};

  // Leading heading — anchors the subpage in rendered Notion view and
  // matches the contract exercised by buildCandidateProfileBlocks tests.
  const blocks = [heading2("Candidate Profile")];

  // Identity lines — bold key, value plain. Mirrors legacy prototype format.
  const name = identity.name || identity.full_name;
  if (name) blocks.push(paragraphRich([{ text: "Name: ", bold: true }, name]));
  if (identity.location) blocks.push(paragraphRich([{ text: "Location: ", bold: true }, identity.location]));
  if (identity.email) blocks.push(paragraphRich([{ text: "Email: ", bold: true }, identity.email]));
  if (identity.phone) blocks.push(paragraphRich([{ text: "Phone: ", bold: true }, identity.phone]));
  if (identity.linkedin) blocks.push(paragraphRich([{ text: "LinkedIn: ", bold: true }, identity.linkedin]));
  if (identity.personal_site) blocks.push(paragraphRich([{ text: "Site: ", bold: true }, identity.personal_site]));
  if (prefs.status) blocks.push(paragraphRich([{ text: "Status: ", bold: true }, prefs.status]));

  // Legacy-style lists
  const roles = splitList(prefs.target_roles);
  if (roles.length) {
    blocks.push(paragraphRich([{ text: "Target Roles:", bold: true }]));
    for (const r of roles) blocks.push(bullet(r));
  }

  const industries = splitList(prefs.target_industries);
  if (industries.length) {
    blocks.push(paragraphRich([
      { text: "Target Industries: ", bold: true },
      industries.join(" · "),
    ]));
  }

  const strengths = splitList(prefs.key_strengths);
  if (strengths.length) {
    blocks.push(paragraphRich([
      { text: "Key Strengths: ", bold: true },
      strengths.join(" · "),
    ]));
  }

  // Legacy engine-era extras (kept for backward compat with simpler profiles).
  const prefLines = [];
  if (prefs.level) prefLines.push(`Level: ${prefs.level}`);
  if (prefs.years_experience !== undefined) prefLines.push(`Years of experience: ${prefs.years_experience}`);
  if (prefs.salary_min_total_comp) {
    const cur = prefs.salary_currency || "USD";
    prefLines.push(`Min total comp: ${prefs.salary_min_total_comp.toLocaleString("en-US")} ${cur}`);
  }
  if (prefs.salary_ideal_total_comp) {
    const cur = prefs.salary_currency || "USD";
    prefLines.push(`Ideal total comp: ${prefs.salary_ideal_total_comp.toLocaleString("en-US")} ${cur}`);
  }
  if (prefs.work_format) prefLines.push(`Work format: ${prefs.work_format}`);
  const locationsOk = splitList(prefs.locations_ok);
  if (locationsOk.length) prefLines.push(`Locations OK: ${locationsOk.join(", ")}`);
  if (prefLines.length) {
    blocks.push(heading3("Preferences"));
    for (const p of prefLines) blocks.push(bullet(p));
  }

  blocks.push(paragraph(subpageSentinel("candidate_profile")));
  return blocks;
}

// Build the Workflow subpage. Single generic skill-commands playbook, used by
// every profile. All commands take `--profile <id>` — the same job-pipeline /
// interview-coach skills serve every profile from one engine.
function buildWorkflowBlocks(profileId, profile) {
  const p = profileId;
  const blocks = [
    // Russian profile-binding callout at the very top — answers "как вызывать
    // команды именно для этого профиля". Loud and visible because the same
    // engine + skills serve every profile; the only per-profile knob is the
    // `--profile <id>` flag.
    calloutRich([
      { text: "Этот профиль вызывается с флагом ", bold: true },
      { text: `--profile ${p}`, code: true, bold: true },
      { text: ". Пример: " },
      { text: `node engine/cli.js scan --profile ${p}`, code: true },
      { text: ". Один и тот же движок и те же скиллы (" },
      { text: "job-pipeline", code: true },
      { text: " + " },
      { text: "interview-coach", code: true },
      { text: ") обслуживают всех кандидатов — разница только в " },
      { text: `--profile ${p}`, code: true },
      { text: " и в данных в " },
      { text: `profiles/${p}/`, code: true },
      { text: "." },
    ], "💡", "blue_background"),
    paragraphRich([
      "Automated pipeline executed by Claude Code on request. The same two skills (",
      { text: "job-pipeline", code: true }, " upstream + ",
      { text: "interview-coach", code: true }, " downstream) serve every profile from one engine — every command below takes ",
      { text: `--profile ${p}`, code: true }, ".",
    ]),
    bulletRich([
      { text: "job-pipeline", code: true, bold: true },
      " — upstream: scan → Notion → CV/CL → submit → sync → check email responses.",
    ]),
    bulletRich([
      { text: "interview-coach", code: true, bold: true },
      " — downstream: prep → mock → debrief → negotiate, triggered once Notion Status reaches ",
      { text: "Interview", code: true },
      " or later.",
    ]),

    heading2("Commands — job-pipeline (upstream)"),

    heading3("/job-pipeline scan — Найти новые вакансии"),
    bulletRich([{ text: `node engine/cli.js scan --profile ${p}`, code: true }, " — scans all target companies via enabled discovery adapters (Greenhouse / Lever / Ashby / SmartRecruiters / Workday / CalCareers / RemoteOK)"]),
    bullet("Level filter — reject Director / Principal / Staff / VP / Intern / Associate / GPM / New Grad"),
    bullet("Company cap — max 3 active jobs per company (Applied + To Apply)"),
    bulletRich(["Dedup — check against ", { text: `profiles/${p}/applications.tsv`, code: true }, " + shared ", { text: "data/jobs.tsv", code: true }]),
    bullet("Create in Notion — all required fields filled, Company relation set (create company if needed)"),
    bullet("Update TSV with notion_id"),
    bullet("Validate: 0 pending notion_ids, 0 empty Company relations, 0 over-level in active"),
    bullet("Report: added X, filtered Y, companies created Z, errors N"),

    heading3("/job-pipeline prepare — Подготовить материалы"),
    paragraph("Two phases: draft everything, then approve before push."),
    bulletRich([{ text: `node engine/cli.js prepare --profile ${p} --phase pre --batch 20`, code: true }, " — collect fresh rows (status=", { text: "To Apply", code: true }, " + no Notion page id), level-validate, skip already-prepared, assign CV archetype, draft CL, compute salary (Tier × Level + COL), emit ", { text: "results-<ts>.json", code: true }]),
    bulletRich(["Review ", { text: "results-<ts>.json", code: true }]),
    bulletRich([{ text: `node engine/cli.js prepare --profile ${p} --phase commit --results-file results-<ts>.json`, code: true }, " — accept drafts: update TSV (resume_version + cl_key + salary), push Notion page (creates page with Status=", { text: "To Apply", code: true }, "), write CL PDF"]),
    bullet("CL rules — 4 paragraphs (Hook → proof paragraph → relevance paragraph → Close), confident-practitioner voice, numbers mandatory. Run /humanizer before showing to user."),
    bullet("Validate: 0 fresh rows remaining, 0 To Apply without CL / CV"),
    bullet("Report: prepared X, skipped Y, archived Z, errors N"),

    heading3("/job-pipeline sync — Синхронизировать статусы"),
    bulletRich([{ text: `node engine/cli.js sync --profile ${p}`, code: true }, " — fetch non-archived pages via Notion API, diff against TSV"]),
    bulletRich(["Parse ", { text: "sync_result.json", code: true }, " — mismatches, empty Company relations, not-in-TSV"]),
    bullet("Apply ALL mismatches to TSV. Notion wins, no exceptions."),
    bulletRich(["Applied / Rejected / Closed: update TSV + append to ", { text: "rejection_log.md", code: true }, " on Rejected"]),
    bullet("Integrity checks: empty Companies, not-in-TSV pages, pending notion_ids"),
    bullet("Report: changes X (Applied A, Rejected B, Closed C), empty companies E, not-in-TSV F"),

    heading3("/job-pipeline check — Проверить ответы по email"),
    paragraph("Two-phase MCP-driven flow (Gmail reads delegated to Claude MCP — no OAuth on disk)."),
    bulletRich([{ text: `node engine/cli.js check --profile ${p} --prepare`, code: true }, " — build active-jobs map from TSV (To Apply / Applied / Interview / Offer), compute cursor epoch, print Gmail batches JSON (10 companies / batch + LinkedIn + recruiter queries)"]),
    bulletRich(["Claude MCP reads Gmail per the printed batches, writes ", { text: "raw_emails.json", code: true }, " into ", { text: `profiles/${p}/.gmail-state/`, code: true }]),
    bulletRich([{ text: `node engine/cli.js check --profile ${p} --apply`, code: true }, " — classify each email (REJECTION / INTERVIEW_INVITE / INFO_REQUEST / ACKNOWLEDGMENT / OTHER), match to role (HIGH / LOW / NONE), update Notion: REJECTION → Rejected + comment; INTERVIEW_INVITE → Interview + comment; INFO_REQUEST → comment only; LOW match → comment asking to clarify"]),
    bulletRich(["Update logs: ", { text: "rejection_log.md", code: true }, ", ", { text: "email_check_log.md", code: true }, ", ", { text: "recruiter_leads.md", code: true }]),
    bulletRich(["Save dedup: ", { text: "processed_messages.json", code: true }, " (auto-prune > 30 days)"]),

    heading3("/job-pipeline validate — Retro blocklist sweep + TSV integrity"),
    bulletRich([{ text: `node engine/cli.js validate --profile ${p}`, code: true }, " — re-apply company + title blocklists to existing To Apply rows (catches rows let through before a filter update)"]),
    bulletRich(["Report matches → exit 1. With ", { text: "--apply", code: true }, ": set ", { text: "status=Archived", code: true }]),
    bullet("Also checks TSV integrity (empty Company relations, stale notion_ids, pending ids)"),

    heading2("Guard Rails (all modes)"),
    bullet("Level filter: PM / Senior PM / Lead PM only. Reject Director, Principal, Staff, VP, AVP, SVP, EVP, GPM, Group PM, Head of, Associate, Junior, Intern, New Grad"),
    bullet("Company cap: max 3 active per company"),
    bullet("Fit Score: domain fit only (Strong / Medium / Weak). Level does NOT affect score."),
    bullet("Early-stage modifier (pre-Series B, <50 people): −1 level"),
    bullet("Notion completeness: every page must have Role, Company (relation), Status, Fit Score, Job URL, Source, Date Added, Work Format, City, State, Notes"),
    bulletRich([
      "US-marker safeguard: location blocklist is skipped when ",
      { text: "united states", code: true }, " / ",
      { text: "usa", code: true }, " / ",
      { text: ", us", code: true }, " / ",
      { text: "(us)", code: true }, " / ",
      { text: "u.s.", code: true }, " is present",
    ]),
    bullet("Recruiter outreach: never mention location / remote / relocation preferences in outbound — reveal as late as possible in the funnel"),
    bullet("Humanizer mandatory on CLs and recruiter email drafts before user review"),

    heading2("Key files"),
    bulletRich([{ text: `profiles/${p}/applications.tsv`, code: true }, " — per-profile vacancy / status registry (v2 schema, 15 cols)"]),
    bulletRich([{ text: "data/jobs.tsv", code: true }, " / ", { text: "data/companies.tsv", code: true }, " — shared cross-profile master pools (dedup)"]),
    bulletRich([{ text: `profiles/${p}/cover_letter_versions.json`, code: true }, " — all CL data"]),
    bulletRich([{ text: `profiles/${p}/resume_versions.json`, code: true }, " — all CV data"]),
    bulletRich([{ text: "engine/cli.js", code: true }, " — entry point for all commands"]),
    bulletRich([{ text: "skills/job-pipeline/SKILL.md", code: true }, " — full skill definition with detailed steps"]),
    bulletRich([{ text: `profiles/${p}/email_check_log.md`, code: true }, " — log of all email check runs"]),
    bulletRich([{ text: `profiles/${p}/.gmail-state/processed_messages.json`, code: true }, " — Gmail dedup registry"]),

    heading2("Commands — interview-coach (downstream)"),
    paragraphRich([
      "All interview-coach commands read ",
      { text: `profiles/${p}/interview-coach-state/constraints.md`, code: true },
      " and ",
      { text: "coaching_state.md", code: true },
      " before running. State is persistent across sessions.",
    ]),

    heading3("/stories — Build / enrich storybank"),
    bullet("Storybank is reusable across all companies — never company-specific"),
    bullet("Seed stories (S001–S00N) pre-loaded from resume — one per notable project or outcome"),
    bulletRich(["Run ", { text: "stories improve S###", code: true }, " to turn a seed into battle-ready STAR with tested Earned Secret"]),
    bullet("Prioritize by leverage: lead with stories that map to this profile's strongest pillars"),

    heading3("/prep [company] — Company + role prep brief"),
    bulletRich(["Trigger: Notion Status transitions ", { text: "Applied → Interview", code: true }]),
    bullet("Read JD + company data from Notion Jobs Pipeline + Companies DBs"),
    bullet("Generate: interviewer intel, round formats, likely questions, story mapping (which S### to deploy)"),
    bulletRich(["Save to ", { text: "coaching_state.md", code: true }, " → Interview Loops"]),

    heading3("/hype — Pre-interview confidence + 3×3 plan"),
    bullet("Run immediately before interview"),
    bullet("Anxiety profile check, 3 strengths to lead with × 3 stories to deploy"),

    heading3("/mock [format] — Full simulated interview"),
    bulletRich(["Formats: ", { text: "behavioral", code: true }, " / ", { text: "system-design", code: true }, " / ", { text: "case-study", code: true }, " / ", { text: "panel", code: true }, " / ", { text: "technical", code: true }]),
    bullet("4–6 questions, scored on 5 dimensions (Substance, Structure, Relevance, Credibility, Differentiation)"),
    bulletRich(["Trigger: subsequent ", { text: "Interview", code: true }, " round (post phone-screen onsite / panel)"]),

    heading3("/debrief — Post-interview rapid capture (same day)"),
    bullet("Run immediately after any real interview"),
    bullet("Captures: questions asked, stories used, recruiter / interviewer feedback, emotional read"),
    bullet("Updates: Interview Intelligence, Storybank Last Used + Use Count, Outcome Log (pending)"),

    heading3("/analyze [transcript] — Transcript scoring"),
    bulletRich(["Place transcript in ", { text: "interview-coach-state/transcripts/", code: true }]),
    bullet("Auto-detects format (Otter / Zoom / Grain / Teams)"),
    bullet("Scores answers on 5 dimensions, identifies root-cause bottleneck, updates Active Coaching Strategy"),

    heading3("/concerns + /questions — Pre-onsite prep"),
    bulletRich([{ text: "concerns", code: true }, ": ranked list of likely interviewer objections + counter strategies"]),
    bulletRich([{ text: "questions", code: true }, ": top 3 tailored questions to ask the interviewer (saved to Interview Loops)"]),

    heading3("/negotiate — Post-offer negotiation"),
    bulletRich(["Trigger: Notion Status → ", { text: "Offer", code: true }]),
    bullet("Inputs: offer details (base / equity / bonus / sign-on), competing offers, BATNA, floor"),
    bullet("Output: stage-by-stage scripts (recruiter callback → first counter → follow-up → close)"),

    heading3("/linkedin · /pitch · /outreach — Positioning layer"),
    bulletRich([{ text: "linkedin", code: true }, ": profile audit (recruiter discoverability, credibility, differentiation)"]),
    bulletRich([{ text: "pitch", code: true }, ": 30–45 sec positioning statement anchored on Earned Secret"]),
    bulletRich([{ text: "outreach", code: true }, ": cold networking coaching (candidate starts from zero US fintech network)"]),

    heading3("/progress · /feedback · /reflect — Meta"),
    bulletRich([{ text: "progress", code: true }, ": trend review, self-calibration, drift detection (every 3 sessions)"]),
    bulletRich([{ text: "feedback", code: true }, ": capture recruiter feedback, outcomes, corrections"]),
    bulletRich([{ text: "reflect", code: true }, ": post-search retrospective + archive (never deletes)"]),

    heading2("Triggers by Notion Status"),
    table(
      [
        ["Status transition", "Coach commands"],
        [
          [{ text: "Applied → Interview", code: true }],
          [{ text: "prep [company]", code: true }, " · ", { text: "hype", code: true }],
        ],
        [
          "after each interview round",
          [
            { text: "debrief", code: true }, " · (opt.) ",
            { text: "analyze [transcript]", code: true }, " · ",
            { text: "mock [format]", code: true }, " · ",
            { text: "questions", code: true }, " · ",
            { text: "concerns", code: true },
          ],
        ],
        [
          [{ text: "Interview → Offer", code: true }],
          [{ text: "negotiate", code: true }],
        ],
        ["Rejection", [{ text: "feedback", code: true }, " · ", { text: "progress", code: true }]],
      ],
      { hasHeader: true }
    ),

    heading2("Guard Rails — interview-coach"),
    bulletRich([
      { text: "Resume FROZEN", bold: true }, ": 13 archetypes only (see Resume Versions subpage). ",
      { text: "/resume", code: true }, " restricted to critique + archetype selection + delta suggestions for ",
      { text: "resume_versions.json", code: true }, ". Never inline-writes or creates company-tailored CVs.",
    ]),
    bulletRich([
      { text: "JD ", bold: true }, { text: "decode", code: true, bold: true },
      { text: " batch DISABLED", bold: true }, ": duplicate of upstream scan + filter_rules pipeline. Single-vacancy decode allowed only for jobs already in Notion, as input to ",
      { text: "prep", code: true }, ".",
    ]),
    bulletRich([
      { text: "Role framing hard-wired", bold: true },
      ": advisory / employment / founder distinctions for each experience are locked in ",
      { text: "constraints.md", code: true },
      " and must be respected across every command.",
    ]),
    bulletRich([{ text: "Notion = source of truth", bold: true }, ": Interview Loops in ", { text: "coaching_state.md", code: true }, " is a working copy. On conflict with Notion, Notion wins."]),
    bulletRich([{ text: "Company cap 3", bold: true }, " still enforced — coach never suggests preparing a 4th loop at the same company."]),
    bulletRich([{ text: "Targeting", bold: true }, ": PM / Senior PM / Lead PM only (same as upstream)."]),
    bulletRich([{ text: "210 chars default", bold: true }, " for Application Q&A form answers."]),
    bulletRich([{ text: "Never delete files", bold: true }, " without explicit permission. ", { text: "reflect", code: true }, " archives only."]),

    heading2("Key files — interview-coach"),
    bulletRich([{ text: "skills/interview-coach/SKILL.md", code: true }, " — upstream skill (installed globally via ", { text: "~/.claude/skills/interview-coach", code: true }, " symlink)"]),
    bulletRich([{ text: "skills/interview-coach/references/", code: true }, " — command reference + engine files"]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/constraints.md`, code: true }, " — project-local overrides (resume freeze, role framing, decode restriction). Read before every coach command."]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/coaching_state.md`, code: true }, " — persistent state (profile, storybank, Interview Loops, Score History, Calibration)"]),
    bulletRich([{ text: `profiles/${p}/interview-coach-state/transcripts/`, code: true }, " — drop real interview transcripts here for ", { text: "analyze", code: true }]),

    paragraph(subpageSentinel("workflow")),
  ];
  return blocks;
}

function buildTargetTierBlocks(profile) {
  const tiers = profile.company_tiers || {};
  const counts = { S: 0, A: 0, B: 0, C: 0 };
  for (const t of Object.values(tiers)) {
    if (counts[t] !== undefined) counts[t]++;
  }
  const totals = `S:${counts.S} | A:${counts.A} | B:${counts.B} | C:${counts.C}`;

  const rows = [
    ["S", "Top target — dream companies; apply whenever a relevant role is open."],
    ["A", "Strong strategic fit; apply within 48h of discovery."],
    ["B", "Worthwhile; apply if bandwidth allows and salary matches."],
    ["C", "Backup / opportunistic; use only if pipeline is thin."],
  ];

  const blocks = [
    heading2("Target Tier"),
    paragraph(
      "Generic tiering scheme. Assign a tier to each company in the Companies DB to drive prioritization."
    ),
  ];
  for (const [tier, text] of rows) {
    const c = counts[tier];
    blocks.push(bullet(`${tier} (${c}) — ${text}`));
  }
  blocks.push(paragraph(`Current counts — ${totals}`));
  blocks.push(paragraph(subpageSentinel("target_tier")));
  return blocks;
}

function buildResumeVersionsSubpageBlocks(versionsFile) {
  const blocks = [
    heading2("Resume Versions"),
    paragraph(
      "Archetypes maintained in resume_versions.json. Use `node engine/cli.js prepare …` to select automatically by tags / title match."
    ),
  ];
  const versions = (versionsFile && versionsFile.versions) || {};
  for (const [key, v] of Object.entries(versions)) {
    const title = v.title || key;
    const summary =
      typeof v.summary === "string"
        ? v.summary
        : Array.isArray(v.summary)
        ? v.summary.map((s) => (typeof s === "string" ? s : s.text || "")).join("")
        : "";
    const line = summary
      ? `${key} — ${title}. ${summary.slice(0, 180)}`
      : `${key} — ${title}`;
    blocks.push(bullet(line));
  }
  blocks.push(paragraph(subpageSentinel("resume_versions")));
  return blocks;
}

// ---------------------------------------------------------------------------
// Hub body
// ---------------------------------------------------------------------------

// Build the hub intro paragraph. Three-tier resolution:
//   1. profile.hub.intro — verbatim override (best for hand-tuned copy).
//   2. preferences-driven template (target_roles[0] + target_industries +
//      identity.location + work_format).
//   3. Minimal fallback if preferences are sparse.
function buildIntro(profile) {
  const hub = (profile && profile.hub) || {};
  if (typeof hub.intro === "string" && hub.intro.trim()) {
    return paragraph(hub.intro.trim());
  }
  const identity = (profile && profile.identity) || {};
  const prefs = (profile && profile.preferences) || {};

  const fullName = identity.name || identity.full_name || "";
  const firstName = fullName.trim().split(/\s+/)[0] || "Candidate";
  // "JARED" → "Jared" if all-caps
  const firstNamePretty = /^[A-Z]+$/.test(firstName)
    ? firstName.charAt(0) + firstName.slice(1).toLowerCase()
    : firstName;

  const roles = splitList(prefs.target_roles);
  const primaryRole = roles[0] || "fitting";

  const industries = splitList(prefs.target_industries);
  let industryPhrase = "";
  if (industries.length === 1) industryPhrase = ` in ${industries[0]}`;
  else if (industries.length === 2) industryPhrase = ` in ${industries.join(" and ")}`;
  else if (industries.length >= 3) industryPhrase = ` in ${industries.slice(0, 2).join(", ")} and adjacent industries`;

  const location = identity.location || (splitList(prefs.locations_ok)[0] || "");

  let formatPhrase = "";
  const fmt = (prefs.work_format || "").toString().toLowerCase();
  if (fmt === "remote" || fmt === "any") formatPhrase = " Remote-friendly.";
  else if (fmt === "hybrid") formatPhrase = " Hybrid acceptable.";
  else if (fmt === "onsite" || fmt === "on-site") formatPhrase = " Onsite preferred.";

  let line = `Central command for ${firstNamePretty}'s US job search. Target: ${primaryRole} roles${industryPhrase}.`;
  if (location) line += ` Location: ${location}.`;
  line += formatPhrase;
  return paragraph(line.trim());
}

function buildLayoutBody({ profileName, profile, subpageIds, dbIds, inboxCount, updatedAt }) {
  // Back-compat: if `profile` not provided, fall back to legacy generic intro.
  const intro = profile
    ? buildIntro(profile)
    : paragraph(
        `${profileName}'s AI Job Search Hub — pipelines, companies, playbooks. Managed via \`node engine/cli.js\`.`
      );

  const col1 = {
    object: "block",
    type: "column",
    column: {
      children: [callout(`Inbox: ${inboxCount} | Updated: ${updatedAt}`, "📥")],
    },
  };

  const col2Children = [heading2("Playbooks")];
  for (const key of ["workflow", "target_tier", "resume_versions"]) {
    if (subpageIds[key]) col2Children.push(linkToPage(subpageIds[key], "page_id"));
  }
  const col2 = { object: "block", type: "column", column: { children: col2Children } };

  const col3Children = [heading2("Databases")];
  for (const key of ["companies_db_id", "application_qa_db_id", "job_platforms_db_id"]) {
    if (dbIds[key]) col3Children.push(linkToPage(dbIds[key], "database_id"));
  }
  const col3 = { object: "block", type: "column", column: { children: col3Children } };

  const columnList = {
    object: "block",
    type: "column_list",
    column_list: { children: [col1, col2, col3] },
  };

  const blocks = [intro];
  if (subpageIds.candidate_profile) {
    blocks.push(linkToPage(subpageIds.candidate_profile, "page_id"));
  }
  blocks.push(columnList);
  blocks.push(divider());
  // Sentinel LAST — its presence means the entire append succeeded.
  blocks.push(paragraph(HUB_LAYOUT_SENTINEL));
  return blocks;
}

// ---------------------------------------------------------------------------
// Notion API helpers
// ---------------------------------------------------------------------------

async function listChildren(client, pageId) {
  const out = [];
  let cursor;
  do {
    const resp = await client.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function hasSubpageSentinel(client, pageId, key) {
  const children = await listChildren(client, pageId);
  const needle = subpageSentinel(key);
  return children.some((b) => paragraphText(b).includes(needle));
}

async function createSubpage(client, parentPageId, title, icon, bodyBlocks) {
  // Notion API limits pages.create to 100 children. For longer bodies we
  // create with the first 90 and append the rest in chunks.
  const FIRST_BATCH = 90;
  const args = {
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
  };
  if (icon) args.icon = { type: "emoji", emoji: icon };
  const all = bodyBlocks || [];
  if (all.length) args.children = all.slice(0, FIRST_BATCH);
  const resp = await client.pages.create(args);
  if (all.length > FIRST_BATCH) {
    await appendBlocks(client, resp.id, all.slice(FIRST_BATCH));
  }
  return resp.id;
}

async function appendBlocks(client, pageId, blocks) {
  const CHUNK = 90; // Notion API limits children to 100 per request.
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await client.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + CHUNK),
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function buildSubpageBody(mode, { profile, versionsFile, profileId }) {
  if (mode === "candidate_profile") return buildCandidateProfileBlocks(profile);
  if (mode === "workflow") return buildWorkflowBlocks(profileId, profile);
  if (mode === "target_tier") return buildTargetTierBlocks(profile);
  if (mode === "resume_versions") return buildResumeVersionsSubpageBlocks(versionsFile);
  throw new Error(`unknown subpage mode: ${mode}`);
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("build_hub_layout", args);

  const id = validateProfileId(args.profile);
  const profilePath = path.join(REPO_ROOT, "profiles", id, "profile.json");
  if (!fs.existsSync(profilePath)) {
    fatal(new Error(`profile.json not found: ${profilePath}`));
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  profile.notion = profile.notion || {};
  profile.notion.hub_layout = profile.notion.hub_layout || {};
  const workspacePageId = args.workspace_page_id || profile.notion.workspace_page_id;
  if (!workspacePageId) {
    fatal(new Error("profile.notion.workspace_page_id missing — run deploy_profile.js first"));
  }

  const token = requireToken(id);
  const client = new Client({ auth: token });

  console.log(`  workspace_page_id: ${workspacePageId}`);

  const versionsPath = path.join(
    REPO_ROOT,
    "profiles",
    id,
    (profile.resume && profile.resume.versions_file) || "resume_versions.json"
  );
  const versionsFile = fs.existsSync(versionsPath)
    ? JSON.parse(fs.readFileSync(versionsPath, "utf8"))
    : { versions: {} };

  const children = await listChildren(client, workspacePageId);
  const existingByTitle = indexExistingChildPages(children);
  const layoutComplete = hasHubLayoutSentinelV1(children);
  const columnListPresent = hasColumnList(children);
  console.log(`  existing child pages: [${[...existingByTitle.keys()].join(", ")}]`);
  console.log(`  layout sentinel v1:   ${layoutComplete}`);
  console.log(`  column_list present:  ${columnListPresent}`);

  if (columnListPresent && !layoutComplete) {
    fatal(
      new Error(
        "Detected partial hub layout (column_list present, sentinel missing).\n" +
          "  A previous --apply likely crashed mid-append. To recover:\n" +
          "    1. Open the workspace page in Notion UI.\n" +
          "    2. Delete every block below the subpage links (the 3-column section + stragglers).\n" +
          "    3. Re-run with --apply."
      )
    );
  }

  const subpageIds = { ...(profile.notion.hub_layout.subpages || {}) };

  // --- Step 1: ensure each subpage exists AND is populated (per-subpage sentinel) ---
  console.log("\n  --- subpages ---");
  for (const s of SUBPAGES) {
    const body = buildSubpageBody(s.mode, {
      profile,
      versionsFile,
      profileId: id,
    });

    // Resolve existing subpage by current title (Russian) OR legacy title
    // (English pre-rename, top-level only) OR profile.json id. The last wins
    // because users may reorganize the hub — subpages can end up nested
    // inside column_lists where listChildren on the workspace page no longer
    // surfaces them by title.
    let existingId = existingByTitle.get(s.title) || subpageIds[s.key];
    if (!existingId && LEGACY_TITLES[s.key]) {
      for (const legacy of LEGACY_TITLES[s.key]) {
        const cand = existingByTitle.get(legacy);
        if (cand) {
          existingId = cand;
          break;
        }
      }
    }
    // Rename: if we have the page id, fetch its current title directly
    // (pages.retrieve) and pages.update if it's an old/legacy title. We
    // can't rely on existingByTitle reverse lookup because the user may
    // have moved the subpage off the top level into a column_list, where
    // it doesn't appear as a direct child_page block of the workspace.
    if (existingId && (LEGACY_TITLES[s.key] || []).length) {
      try {
        const page = await client.pages.retrieve({ page_id: existingId });
        const titleProp = Object.values(page.properties || {}).find((v) => v.type === "title");
        const currentTitle = titleProp?.title?.[0]?.plain_text || "";
        if (currentTitle && currentTitle !== s.title) {
          console.log(`    [${s.key}] rename "${currentTitle}" → "${s.title}" on ${existingId}`);
          if (args.apply) {
            await client.pages.update({
              page_id: existingId,
              properties: { title: { title: [{ type: "text", text: { content: s.title } }] } },
            });
          }
        }
      } catch (err) {
        console.log(`    [${s.key}] rename check failed for ${existingId}: ${err.message}`);
      }
    }
    if (existingId) {
      subpageIds[s.key] = existingId;
      const sentinelPresent = await hasSubpageSentinel(client, existingId, s.key);
      if (sentinelPresent) {
        console.log(`    [${s.key}] exists + populated: ${existingId}`);
        continue;
      }
      console.log(`    [${s.key}] exists but empty — will append ${body.length} blocks to ${existingId}`);
      if (!args.apply) continue;
      await appendBlocks(client, existingId, body);
      console.log(`    [${s.key}] populated`);
      continue;
    }

    console.log(`    [${s.key}] will create "${s.title}" with ${body.length} blocks`);
    if (!args.apply) continue;
    const newId = await createSubpage(client, workspacePageId, s.title, s.icon, body);
    subpageIds[s.key] = newId;
    console.log(`    [${s.key}] created: ${newId}`);
  }

  // --- Step 2: append main layout body if not present ---
  console.log("\n  --- main layout ---");
  if (layoutComplete) {
    console.log("    hub sentinel v1 present — skip body append");
  } else {
    const dbIds = {
      companies_db_id: profile.notion.companies_db_id,
      application_qa_db_id: profile.notion.application_qa_db_id,
      job_platforms_db_id: profile.notion.job_platforms_db_id,
    };
    let inboxCount = 0;
    try {
      const { load } = require("../../engine/core/applications_tsv.js");
      const tsvPath = path.join(REPO_ROOT, "profiles", id, "applications.tsv");
      if (fs.existsSync(tsvPath)) {
        const { apps } = load(tsvPath);
        // "Inbox" semantics in the unified 8-status set: status="To Apply"
        // AND not yet pushed to Notion (no notion_page_id). Once a row gets
        // a Notion page (CV+CL prepared), it stays "To Apply" but leaves
        // the inbox queue.
        inboxCount = apps.filter((a) => a.status === "To Apply" && !a.notion_page_id).length;
      }
    } catch (err) {
      console.log(`    inbox count unavailable: ${err.message}`);
    }
    const updatedAt = new Date().toISOString().slice(0, 10);
    const blocks = buildLayoutBody({
      profileName: (profile.identity && (profile.identity.name || profile.identity.full_name)) || id,
      profile,
      subpageIds,
      dbIds,
      inboxCount,
      updatedAt,
    });
    console.log(`    will append ${blocks.length} blocks to workspace page`);
    if (args.apply) {
      await appendBlocks(client, workspacePageId, blocks);
      console.log("    appended");
    }
  }

  // --- Step 3: persist to profile.json + .stage18/state.json ---
  profile.notion.workspace_page_id = workspacePageId;
  profile.notion.hub_layout = { ...profile.notion.hub_layout, subpages: subpageIds };
  if (args.apply) {
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
    const { data: state } = loadState(id);
    state.build_hub_layout = {
      done: true,
      at: new Date().toISOString(),
      subpages: subpageIds,
      sentinel: HUB_LAYOUT_SENTINEL,
    };
    saveState(id, state);
    console.log("\n  [profile.json] updated with hub_layout.subpages");
  }

  done("build_hub_layout", { profile_id: id, subpages: subpageIds });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = {
  SUBPAGES,
  LEGACY_TITLES,
  HUB_LAYOUT_SENTINEL,
  hasHubLayoutSentinelV1,
  subpageSentinel,
  buildCandidateProfileBlocks,
  buildWorkflowBlocks,
  buildTargetTierBlocks,
  buildResumeVersionsSubpageBlocks,
  buildIntro,
  buildLayoutBody,
  buildSubpageBody,
  splitList,
};
