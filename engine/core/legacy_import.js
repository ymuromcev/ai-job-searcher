// Pure helpers for importing a previous application bot's history from a
// mailbox into the per-profile ledger (RFC 068 §7, unit U2).
//
// The legacy bot applied to many jobs; its ATS acknowledgements, rejections
// and interview invites sit in a mailbox. This module turns those messages
// into a reviewable plan against `applications.tsv`:
//
//   messages ──classifyMessage──▶ events ──group──▶ applications
//            ──match by company + title──▶ { updates, appends, unparseable }
//
// Classification reuses the production `check` classifier
// (`engine/core/classifier.js`) and its pre-filters
// (`engine/core/email_filters.js`). Company / title normalization reuses
// `engine/core/dedup.js`. The only new logic here is the extraction of
// company + job title from ATS confirmation emails (the tracking matcher works
// the other way round — it needs a known company list — so it can't be used
// to discover rows that are not in the TSV yet).
//
// No I/O: the script (`scripts/import_zoho_applications.js`) owns IMAP, mbox
// files, the plan file and the TSV write.

const crypto = require("crypto");

const { classify } = require("./classifier.js");
const { isJobAlert, isNonPipelineSender, isATS } = require("./email_filters.js");
const { extractSenderName } = require("./email_parsers.js");
const { normalizeCompanyName, normalizeTitle, fuzzyKey } = require("./dedup.js");
const { appendNew, makeKey } = require("./applications_tsv.js");

const LEGACY_SOURCE = "legacy_bot";
const APPLIED_BY = "legacy_bot";
const APPLY_STATE = "submitted";
const NOTE_PREFIX = "zoho";

// Classifier type → ledger event. INFO_REQUEST (assessment / take-home) is
// evidence that an application exists but is not a status change of its own
// (check treats it as comment-only), so it counts as "Applied".
const TYPE_TO_EVENT = {
  ACKNOWLEDGMENT: "Applied",
  INFO_REQUEST: "Applied",
  REJECTION: "Rejected",
  INTERVIEW_INVITE: "Interview",
  POSITION_CLOSED: "Closed",
};

// ---------- Text helpers ----------

// Abbreviations whose trailing dot would otherwise end a "sentence" inside a
// title or company capture ("Sr. Product Manager", "Acme Inc.").
const ABBREV_RE = /\b(Sr|Jr|Snr|Assoc|Mgr|Dir|Inc|Co|Corp|Ltd|St|Mr|Ms|Mrs|Dr)\./g;

function cleanText(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(ABBREV_RE, "$1")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// One character of a title/company capture: anything but a sentence end or a
// newline; a dot is allowed when glued to the next char ("Booking.com").
const T = "(?:[^.!?\\n]|\\.(?=\\S))";
// Where a company capture stops.
const C_END =
  "(?=\\s*(?:[!,;:?()\\n]|\\.(?:\\s|$)|$)|\\s+[-–—|]\\s|\\s+(?:for|and|we|to|is|has|regarding|about|on|team)\\b)";
const POS_WORD = "(?:position|role|job|opening|opportunity|posting|vacancy)";
const APPLY_WORD = "(?:applying|applied|application|apply|interest)";

// Ordered extraction rules. Each yields `t` (title) and/or `c` (company).
// Rules are tried against the subject first, then the body; the first valid
// value per field wins.
const RULES = [
  // "applying for the Senior PM position at Acme" / "application for Senior PM at Acme"
  {
    name: "title_at_company",
    re: new RegExp(
      `${APPLY_WORD}\\s+(?:to|for|in)\\s+(?:the\\s+|our\\s+)?(?:position\\s+of\\s+)?(?<t>${T}{2,120}?)\\s+(?:${POS_WORD}\\s+)?(?:at|with)\\s+(?<c>${T}{1,60}?)${C_END}`,
      "i"
    ),
  },
  // "Thank you for your interest in Acme. We received your application for the
  // Senior PM role" — title only, needs an explicit position word.
  {
    name: "title_position_word",
    re: new RegExp(
      `${APPLY_WORD}\\s+(?:to|for|in)\\s+(?:the\\s+|our\\s+)?(?:position\\s+of\\s+)?(?<t>${T}{2,120}?)\\s+${POS_WORD}\\b`,
      "i"
    ),
  },
  // Greenhouse: "we received your application for Senior PM, Growth, and we
  // are delighted..." — no position word, ends at ", and" / sentence end.
  {
    name: "received_application_for",
    re: new RegExp(
      `(?:received|submitted|reviewing|review)\\s+(?:your|the)\\s+application\\s+for\\s+(?:the\\s+)?(?:position\\s+of\\s+)?(?<t>${T}{2,120}?)(?:\\s+${POS_WORD}\\b|(?=\\s*(?:,\\s*(?:and|we|which|it|as|but)\\b|[.!?\\n]|$)))`,
      "i"
    ),
  },
  // "Thank you for applying to Acme!" / "Your application to Acme"
  {
    name: "apply_to_company",
    re: new RegExp(
      `${APPLY_WORD}\\s+(?:to|with|in|at)\\s+(?:joining\\s+|working\\s+(?:at|with)\\s+)?(?<c>${T}{1,60}?)${C_END}`,
      "i"
    ),
  },
  // Workday / Ashby: "Application Received for Senior PM" / "Thank you for your
  // application - Senior PM" / "Application confirmation: Senior PM at Acme".
  {
    name: "subject_ack_for",
    subjectOnly: true,
    re: /^(?:re:\s*|fwd?:\s*)*(?:your\s+)?(?:application\s+(?:received|confirmation|confirmed|submitted)|thank(?:s| you) for (?:your application|applying))\s*(?:for|[-–—:|])\s*(?:the\s+)?(?<rest>.+)$/i,
  },
  // Status-update subjects: "Interview invitation: Senior PM at Acme",
  // "Update on your application - Acme", "Next steps for Senior PM".
  {
    name: "subject_status_for",
    subjectOnly: true,
    re: /^(?:re:\s*|fwd?:\s*)*(?:interview\s+(?:invitation|request|invite)|invitation to interview|next steps|update on your application|application update|regarding your application|your application(?:\s+status)?|status of your application)\s*(?:for|with|at|[-–—:|])\s*(?:the\s+)?(?<rest>.+)$/i,
  },
  // iCIMS / generic: "Acme: Application Received - Senior PM",
  // "Acme - Thank you for applying".
  {
    name: "subject_company_prefix",
    subjectOnly: true,
    re: /^(?:re:\s*|fwd?:\s*)*(?<c>[^:|\-–—]{2,60}?)\s*[:|\-–—]\s*(?:application\s+(?:received|confirmation|update)|thank(?:s| you) for (?:applying|your application|your interest))(?:\s*[-–—:|]\s*(?<t>.+))?$/i,
  },
  // Labelled fields in the body: "Job Title: Senior PM", "Position: Senior PM".
  {
    name: "labelled_title",
    bodyOnly: true,
    re: /(?:^|\n)\s*(?:job\s+title|position\s+title|position|role|job)\s*:\s*(?<t>[^\n]{2,120})/i,
  },
  {
    name: "labelled_company",
    bodyOnly: true,
    re: /(?:^|\n)\s*(?:company(?:\s+name)?|employer|organization)\s*:\s*(?<c>[^\n]{2,60})/i,
  },
];

const ROLE_WORD_RE =
  /\b(manager|engineer|director|lead|analyst|product|designer|head|vp|owner|specialist|scientist|marketing|growth|operations|developer|architect|consultant|associate|coordinator|strategist|researcher|president|officer|principal|staff|senior|intern)\b/i;

// A capture that reads like a job title is not a company ("Thank you for your
// interest in Senior Product Manager").
const TITLE_SHAPE_RE =
  /\b(manager|engineer|director|analyst|designer|specialist|scientist|developer|architect|consultant|coordinator|strategist|researcher|officer|intern|head of|vp of)\b/i;

const LEADING_STOP_RE =
  /^(?:the|a|an|our|your|this|that|us|you|we|it|my|any|all|join|joining|working)\b/i;
const COMPANY_REJECT_RE =
  /\b(position|role|opening|application|candidacy|opportunity|job|jobs|interest|team|us|you)\b/i;
const GENERIC_SENDER_RE =
  /^(?:no-?reply|do-?not-?reply|notifications?|careers?|jobs?|recruiting|recruitment|talent|talent acquisition|hr|human resources|hiring|hiring team|team|workday|greenhouse|lever|ashby|icims|smartrecruiters|smart recruiters|myworkday|myworkdayjobs|support|info|mailer-daemon|postmaster)$/i;

// ATS display-name noise: "Acme Hiring Team", "Acme Recruiting", "Acme via Greenhouse".
const SENDER_NOISE_RE =
  /\s*(?:[-–—|@]\s*)?(?:hiring team|recruiting team|talent acquisition(?: team)?|recruiting|recruitment|careers|jobs|talent team|people team|hr team|via\s+\w+|@\s*\w+|team)\s*$/i;

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "zoho.com",
  "zohomail.com",
  "proton.me",
  "protonmail.com",
  "linkedin.com",
  "indeed.com",
]);

function stripReqId(s) {
  return String(s || "")
    .replace(
      /\s*[([]?\s*(?:req(?:uisition)?\.?\s*(?:id|#|no\.?)?\s*:?\s*|job\s*(?:id|#)\s*:?\s*|#\s*)[\w-]*\d[\w-]*\s*[)\]]?\s*$/i,
      ""
    )
    .replace(/\s*[-–—|]?\s*[([]?\b(?:R|JR|REQ)[-_]?\d{3,}[)\]]?\s*$/i, "")
    .trim();
}

function tidy(s) {
  return String(s || "")
    .replace(/^[\s"'“”‘’«»*_-]+|[\s"'“”‘’«»*_,;:!.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validTitle(raw) {
  const t = tidy(stripReqId(tidy(raw)));
  if (t.length < 2 || t.length > 120) return null;
  if (t.split(" ").length > 14) return null;
  if (LEADING_STOP_RE.test(t)) return null;
  if (/\b(application|candidacy|interest)\b/i.test(t)) return null;
  return t;
}

function validCompany(raw) {
  const c = tidy(raw);
  if (c.length < 1 || c.length > 60) return null;
  if (c.split(" ").length > 6) return null;
  // Original case survives the /i regexes: a company starts with a capital
  // letter or a digit ("the Senior PM role" is prose, "The Home Depot" is a name).
  if (!/^[A-Z0-9]/.test(c)) return null;
  if (/^(?:Our|Your|This|That|Us|You|We|It|My|Any|All)\b/.test(c)) return null;
  if (COMPANY_REJECT_RE.test(c)) return null;
  if (TITLE_SHAPE_RE.test(c)) return null;
  if (GENERIC_SENDER_RE.test(c)) return null;
  return c;
}

// "Senior PM at Acme" / "Acme - Senior PM" / "Senior PM" / "Acme".
function splitRest(rest) {
  const r = tidy(stripReqId(rest));
  let m = r.match(new RegExp(`^(?<t>.+?)\\s+(?:at|with)\\s+(?<c>.+)$`, "i"));
  if (m) return { t: m.groups.t, c: m.groups.c };
  m = r.match(/^(?<a>.+?)\s+[-–—|:]\s+(?<b>.+)$/);
  if (m) {
    const aRole = ROLE_WORD_RE.test(m.groups.a);
    const bRole = ROLE_WORD_RE.test(m.groups.b);
    if (aRole && !bRole) return { t: m.groups.a, c: m.groups.b };
    if (bRole && !aRole) return { t: m.groups.b, c: m.groups.a };
    return {};
  }
  return ROLE_WORD_RE.test(r) ? { t: r } : { c: r };
}

function companyFromSender(from) {
  const raw = String(from || "");
  const name = extractSenderName(raw);
  const cleaned = tidy(String(name || "").replace(SENDER_NOISE_RE, ""));
  const fromName = validCompany(cleaned);
  if (fromName) return fromName;
  const addr0 = (raw.match(/<([^>]+)>/) || [null, raw])[1];
  // Bare ATS tenant address, no display name: "acme@myworkday.com" → "Acme".
  if (!/</.test(raw) && isATS(addr0)) {
    const local = String(addr0.split("@")[0] || "").trim();
    if (local && !GENERIC_SENDER_RE.test(local) && /^[a-z0-9][a-z0-9_-]{1,40}$/i.test(local)) {
      return validCompany(local.charAt(0).toUpperCase() + local.slice(1));
    }
    return null;
  }
  // Non-ATS corporate sender: "careers@acme.com" → "Acme".
  const addr = (raw.match(/<([^>]+)>/) || [null, raw])[1];
  const domain = String(addr.split("@")[1] || "")
    .toLowerCase()
    .trim();
  if (!domain || FREE_MAIL_DOMAINS.has(domain) || isATS(domain)) return null;
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  const label = parts[parts.length - 2];
  if (!label || GENERIC_SENDER_RE.test(label) || label.length < 2) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Pull { company, title } out of an ATS email. Returns nulls when a field
// can't be found — the caller decides whether the message is usable.
function extractCompanyTitle({ subject, from, body } = {}) {
  const s = cleanText(subject).replace(/\n/g, " ");
  const b = cleanText(body).slice(0, 5000);
  let company = null;
  let title = null;
  let rule = null;
  const take = (groups, name) => {
    if (!groups) return;
    let { t, c } = groups;
    if (groups.rest) ({ t, c } = splitRest(groups.rest));
    const vt = t ? validTitle(t) : null;
    const vc = c ? validCompany(c) : null;
    if (vt && !title) {
      title = vt;
      rule = rule || name;
    }
    if (vc && !company) {
      company = vc;
      rule = rule || name;
    }
  };
  for (const [i, text] of [s, b].entries()) {
    const isSubject = i === 0;
    for (const r of RULES) {
      if (r.subjectOnly && !isSubject) continue;
      if (r.bodyOnly && isSubject) continue;
      const m = text.match(r.re);
      if (m) take(m.groups, r.name);
      if (company && title) break;
    }
    if (company && title) break;
  }
  let companySource = company ? "text" : null;
  if (!company) {
    company = companyFromSender(from);
    if (company) companySource = "sender";
  }
  if (title && company && normalizeTitle(title) === normalizeTitle(company)) title = null;
  return { company, title, companySource, rule };
}

// ---------- Normalization / keys ----------

// Looser than dedup.normalizeTitle: also folds dashes / pipes / colons and the
// "Sr" abbreviation so "Sr. Product Manager - Growth" meets
// "Senior Product Manager, Growth".
function looseTitle(title) {
  return normalizeTitle(title)
    .replace(/[-–—|:&+]/g, " ")
    .replace(/\bsr\b/g, "senior")
    .replace(/\bjr\b/g, "junior")
    .replace(/\bmgr\b/g, "manager")
    .replace(/\s+/g, " ")
    .trim();
}

// Alias map from profile.json.company_aliases ({ Parent: [Brand, ...] }) to
// normalized brand → normalized parent.
function buildAliasIndex(companyAliases = {}) {
  const idx = new Map();
  for (const [parent, brands] of Object.entries(companyAliases || {})) {
    const p = normalizeCompanyName(parent);
    if (!p || !Array.isArray(brands)) continue;
    for (const b of brands) {
      const nb = normalizeCompanyName(b);
      if (nb) idx.set(nb, p);
    }
  }
  return idx;
}

function companyKey(name, aliasIndex) {
  const n = normalizeCompanyName(name);
  return (aliasIndex && aliasIndex.get(n)) || n;
}

function appKey(company, title, aliasIndex) {
  const c = companyKey(company, aliasIndex);
  const t = looseTitle(title);
  if (!c || !t) return null;
  return `${c}::${t}`;
}

// Stable synthetic jobId for a row we have never seen in the TSV.
function syntheticJobId(company, title) {
  const basis = `${normalizeCompanyName(company)}::${looseTitle(title)}`;
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12);
}

function toIsoDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

// ---------- Classification ----------

// Returns { event, type, filtered } — event ∈ Applied | Rejected | Interview |
// Closed | null.
function classifyMessage(msg = {}) {
  const from = msg.from || "";
  const subject = msg.subject || "";
  if (isJobAlert(from, subject) || isNonPipelineSender(from)) {
    return { event: null, type: "FILTERED", filtered: true };
  }
  const { type } = classify({ subject, body: msg.body || "" });
  return { event: TYPE_TO_EVENT[type] || null, type, filtered: false };
}

// ---------- Status merge ----------

const KEEP_ALWAYS = new Set(["Interview", "Offer", "Rejected", "Closed"]);
const LATER_THAN_APPLIED = new Set(["Interview", "Rejected", "Closed"]);

// Status after folding an imported status into an existing row.
//   - Interview / Offer are never downgraded.
//   - Rejected / Closed are kept: `check` saw them, and the mailbox history
//     can't prove a later reversal.
//   - Applied / No Response move only forward (Interview / Rejected / Closed).
//   - Inbox / To Apply / Archived / empty take the imported status.
function decideStatus(existing, incoming) {
  const cur = String(existing || "");
  if (!incoming) return cur;
  if (KEEP_ALWAYS.has(cur)) return cur;
  if (cur === "Applied" || cur === "No Response") {
    return LATER_THAN_APPLIED.has(incoming) ? incoming : cur;
  }
  return incoming;
}

// Field patch for an existing row. `summary` = { status, appliedDate }.
// Provenance fields are only filled when empty — a row applied by the new bot
// or by hand keeps its own record.
function computePatch(row, summary) {
  const patch = {};
  const nextStatus = decideStatus(row.status, summary.status);
  if (nextStatus !== row.status) patch.status = nextStatus;
  const ad = summary.appliedDate;
  if (ad && (!row.applied_date || ad < row.applied_date)) patch.applied_date = ad;
  if (!row.applied_by) {
    patch.applied_by = APPLIED_BY;
    if (!row.apply_state) patch.apply_state = APPLY_STATE;
    if (!row.apply_note && ad) patch.apply_note = `${NOTE_PREFIX}:${ad}`;
  }
  return patch;
}

// ---------- Plan ----------

function summarizeEvents(events) {
  const sorted = events.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dated = sorted.filter((e) => e.date);
  const acks = dated.filter((e) => e.event === "Applied");
  const appliedDate = (acks[0] || dated[0] || {}).date || "";
  const progress = sorted.filter((e) => e.event !== "Applied");
  const status = progress.length ? progress[progress.length - 1].event : "Applied";
  return {
    status,
    appliedDate,
    events: sorted.map((e) => ({ date: e.date, event: e.event, subject: e.subject })),
  };
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

// Statuses that prove a row was actually applied to — used only to attach a
// title-less rejection / invite to the single applied row of that company.
const APPLIED_LIKE = new Set([
  "Applied",
  "Interview",
  "Offer",
  "No Response",
  "Rejected",
  "Closed",
]);

// Build the import plan. Pure.
//   apps      — current TSV rows (applications_tsv.load().apps)
//   messages  — [{ messageId, subject, from, body, date }]
//   opts      — { since: "YYYY-MM-DD", companyAliases, now }
function buildPlan(apps, messages, opts = {}) {
  const since = opts.since || "";
  const aliasIndex = buildAliasIndex(opts.companyAliases);
  const stats = {
    scanned: 0,
    filtered: 0,
    outOfRange: 0,
    duplicates: 0,
    classified: { Applied: 0, Rejected: 0, Interview: 0, Closed: 0, OTHER: 0 },
    matchedRows: 0,
    updates: 0,
    unchanged: 0,
    newRows: 0,
    unparseable: 0,
    notionLinkedUpdates: 0,
  };
  const unparseable = [];
  const unclassifiedAts = [];

  // Index TSV rows by company+loose-title.
  const rowIndex = new Map();
  const rowsByCompany = new Map();
  for (const row of apps) {
    const k = appKey(row.companyName, row.title, aliasIndex);
    if (k && !rowIndex.has(k)) rowIndex.set(k, row);
    const ck = companyKey(row.companyName, aliasIndex);
    if (ck) {
      if (!rowsByCompany.has(ck)) rowsByCompany.set(ck, []);
      rowsByCompany.get(ck).push(row);
    }
  }

  const groups = new Map(); // appKey → { companies[], titles[], events[], rowKey? }
  const companyOnly = [];
  const seenIds = new Set();

  for (const msg of messages) {
    stats.scanned += 1;
    const id = msg.messageId || "";
    if (id) {
      if (seenIds.has(id)) {
        stats.duplicates += 1;
        continue;
      }
      seenIds.add(id);
    }
    const date = toIsoDate(msg.date);
    if (since && date && date < since) {
      stats.outOfRange += 1;
      continue;
    }
    const c = classifyMessage(msg);
    if (c.filtered) {
      stats.filtered += 1;
      continue;
    }
    if (!c.event) {
      stats.classified.OTHER += 1;
      if (isATS(msg.from || "")) unclassifiedAts.push({ subject: msg.subject || "", date });
      continue;
    }
    stats.classified[c.event] += 1;
    const ex = extractCompanyTitle(msg);
    const ev = { date, event: c.event, subject: msg.subject || "" };
    if (ex.company && ex.title) {
      const k = appKey(ex.company, ex.title, aliasIndex);
      if (!groups.has(k)) groups.set(k, { companies: [], titles: [], events: [] });
      const g = groups.get(k);
      g.companies.push(ex.company);
      g.titles.push(ex.title);
      g.events.push(ev);
    } else if (ex.company) {
      companyOnly.push({ company: ex.company, ev });
    } else {
      unparseable.push({ subject: ev.subject, date, event: c.event, reason: "no_company" });
    }
  }

  // Title-less messages: attach to the single group of that company found in
  // this import, else to the single applied-like TSV row of that company.
  for (const { company, ev } of companyOnly) {
    const ck = companyKey(company, aliasIndex);
    const sameCompany = [...groups.keys()].filter((k) => k.startsWith(`${ck}::`));
    if (sameCompany.length === 1) {
      groups.get(sameCompany[0]).events.push(ev);
      continue;
    }
    const applied = (rowsByCompany.get(ck) || []).filter((r) => APPLIED_LIKE.has(r.status));
    if (sameCompany.length === 0 && applied.length === 1 && ev.event !== "Applied") {
      const row = applied[0];
      const k = appKey(row.companyName, row.title, aliasIndex);
      if (!groups.has(k)) groups.set(k, { companies: [], titles: [], events: [] });
      const g = groups.get(k);
      g.companies.push(row.companyName);
      g.titles.push(row.title);
      g.events.push(ev);
      continue;
    }
    unparseable.push({
      subject: ev.subject,
      date: ev.date,
      event: ev.event,
      reason: sameCompany.length > 1 || applied.length > 1 ? "ambiguous_title" : "no_title",
    });
  }

  const updates = [];
  const appends = [];
  const unchanged = [];
  for (const [k, g] of groups) {
    const summary = summarizeEvents(g.events);
    const row = rowIndex.get(k);
    if (row) {
      stats.matchedRows += 1;
      const patch = computePatch(row, summary);
      if (Object.keys(patch).length === 0) {
        stats.unchanged += 1;
        unchanged.push({ key: row.key });
        continue;
      }
      stats.updates += 1;
      if (row.notion_page_id) stats.notionLinkedUpdates += 1;
      updates.push({
        key: row.key,
        companyName: row.companyName,
        title: row.title,
        notion_page_id: row.notion_page_id || "",
        before: {
          status: row.status || "",
          applied_date: row.applied_date || "",
          applied_by: row.applied_by || "",
          apply_state: row.apply_state || "",
        },
        patch,
        summary,
      });
    } else {
      const companyName = mostCommon(g.companies);
      const title = mostCommon(g.titles);
      const jobId = syntheticJobId(companyName, title);
      stats.newRows += 1;
      appends.push({
        key: makeKey(LEGACY_SOURCE, jobId),
        source: LEGACY_SOURCE,
        jobId,
        companyName,
        title,
        url: "",
        summary,
      });
    }
  }
  stats.unparseable = unparseable.length;

  return {
    version: 1,
    kind: "legacy_mail_import",
    createdAt: opts.now || new Date().toISOString(),
    since,
    stats,
    updates,
    appends,
    unchanged,
    unparseable,
    unclassifiedAts,
  };
}

// ---------- Apply ----------

// Apply a plan to the current TSV rows. Pure — returns new rows + counters.
// Each planned update is re-merged against the row as it is NOW (the TSV may
// have moved since the dry-run), so the status guards still hold. Appends go
// through applications_tsv.appendNew (exact key + fuzzy company/title dedup);
// a fuzzy hit folds the summary into that existing row instead.
function applyPlan(apps, plan, { now = new Date().toISOString() } = {}) {
  let rows = apps.map((r) => ({ ...r }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const result = { updated: 0, appended: 0, unchanged: 0, missing: [] };

  const fold = (row, summary) => {
    const patch = computePatch(row, summary);
    if (Object.keys(patch).length === 0) {
      result.unchanged += 1;
      return;
    }
    Object.assign(row, patch, { updatedAt: now });
    result.updated += 1;
  };

  for (const u of plan.updates || []) {
    const row = byKey.get(u.key);
    if (!row) {
      result.missing.push(u.key);
      continue;
    }
    fold(row, u.summary);
  }

  for (const a of plan.appends || []) {
    const existing = byKey.get(a.key);
    if (existing) {
      fold(existing, a.summary);
      continue;
    }
    const job = {
      source: a.source,
      jobId: a.jobId,
      companyName: a.companyName,
      title: a.title,
      url: a.url || "",
      locations: [],
    };
    const out = appendNew(rows, [job], { now, defaultStatus: a.summary.status });
    if (out.fresh.length === 1) {
      const fresh = out.fresh[0];
      const ad = a.summary.appliedDate || "";
      Object.assign(fresh, {
        applied_date: ad,
        applied_by: APPLIED_BY,
        apply_state: APPLY_STATE,
        apply_note: ad ? `${NOTE_PREFIX}:${ad}` : NOTE_PREFIX,
      });
      rows = out.apps;
      byKey.set(fresh.key, fresh);
      result.appended += 1;
      continue;
    }
    // Fuzzy duplicate of an existing row → fold into it.
    const fk = fuzzyKey(job);
    const dup = rows.find((r) => fuzzyKey(r) === fk);
    if (dup) fold(dup, a.summary);
    else result.missing.push(a.key);
  }

  return { apps: rows, ...result };
}

// ---------- mbox ----------

// Split an mbox export into raw RFC 822 messages. Handles mboxo / mboxrd
// ("From " separator lines, ">From " quoting). Pure string function.
// Strict separator: "From <addr-or-dash> <Weekday> ..." (Google Takeout,
// Thunderbird, mutt). Falls back to any "From " line when an exporter writes
// a non-standard envelope line.
const MBOX_SEP_STRICT = /^From \S+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;
const MBOX_SEP_LOOSE = /^From /;

function splitMbox(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sep = lines.some((l) => MBOX_SEP_STRICT.test(l)) ? MBOX_SEP_STRICT : MBOX_SEP_LOOSE;
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (sep.test(line)) {
      if (cur) out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    if (cur === null) continue; // junk before the first separator
    cur.push(line.replace(/^>(>*From )/, "$1"));
  }
  if (cur) out.push(cur.join("\n"));
  return out.map((m) => m.replace(/\n+$/, "\n")).filter((m) => m.trim().length > 0);
}

// ---------- Report ----------

function formatReport(plan, { source = "", planPath = "" } = {}) {
  const s = plan.stats;
  const lines = [];
  lines.push("Legacy application import — plan");
  if (source) lines.push(`source: ${source}`);
  if (plan.since) lines.push(`since: ${plan.since}`);
  lines.push(
    `messages scanned: ${s.scanned} (filtered alerts/non-job: ${s.filtered}, before --since: ${s.outOfRange}, duplicate ids: ${s.duplicates})`
  );
  lines.push(
    `classified: Applied ${s.classified.Applied}, Rejected ${s.classified.Rejected}, Interview ${s.classified.Interview}, Closed ${s.classified.Closed}, other ${s.classified.OTHER}`
  );
  lines.push(
    `matched TSV rows: ${s.matchedRows} (to update: ${s.updates}, already up to date: ${s.unchanged})`
  );
  lines.push(`new rows: ${s.newRows}`);
  lines.push(`unparseable: ${s.unparseable}`);
  if (plan.updates.length) {
    lines.push("", "Updates:");
    for (const u of plan.updates) {
      const fields = Object.entries(u.patch)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      lines.push(`  ${u.companyName} — ${u.title} [${u.before.status || "-"}] → ${fields}`);
    }
  }
  if (plan.appends.length) {
    lines.push("", "New rows:");
    for (const a of plan.appends) {
      lines.push(
        `  ${a.companyName} — ${a.title} → status=${a.summary.status} applied_date=${a.summary.appliedDate || "-"}`
      );
    }
  }
  if (plan.unparseable.length) {
    lines.push("", "Unparseable (subject / date):");
    for (const u of plan.unparseable) {
      lines.push(`  ${u.date || "????-??-??"}  ${u.subject}  (${u.event}, ${u.reason})`);
    }
  }
  if (plan.unclassifiedAts && plan.unclassifiedAts.length) {
    lines.push("", "ATS messages the classifier did not recognise (subject / date):");
    for (const u of plan.unclassifiedAts) lines.push(`  ${u.date || "????-??-??"}  ${u.subject}`);
  }
  if (s.notionLinkedUpdates > 0) {
    lines.push(
      "",
      `Note: ${s.notionLinkedUpdates} updated row(s) have a Notion page. This import does not touch Notion; ` +
        "set their Notion status too, or the next `sync` pull will overwrite the TSV status."
    );
  }
  if (planPath) lines.push("", `plan: ${planPath}`);
  return lines.join("\n");
}

module.exports = {
  LEGACY_SOURCE,
  APPLIED_BY,
  APPLY_STATE,
  TYPE_TO_EVENT,
  extractCompanyTitle,
  companyFromSender,
  splitRest,
  looseTitle,
  appKey,
  buildAliasIndex,
  syntheticJobId,
  toIsoDate,
  classifyMessage,
  decideStatus,
  computePatch,
  summarizeEvents,
  buildPlan,
  applyPlan,
  splitMbox,
  formatReport,
};
