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

const NAMED_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  zwnj: "",
  zwj: "",
  shy: "",
};

// Decode HTML entities that leak into plain-text parts ("Manager&nbsp;opportunity").
function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      if (code === 0xa0 || code === 0x200b || code === 0xfeff) return " ";
      return String.fromCodePoint(code);
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

const LOOKS_HTML_RE = /<\/?(?:p|div|br|span|a|td|tr|table|html|body|font|strong|b|i)\b[^>]*>/i;

// Plain, readable text from a message body: HTML stripped (also when a
// text/plain part carries raw markup), entities decoded, whitespace collapsed.
function plainText(text, html) {
  let t = text || "";
  if (!t && html) t = stripHtml(html);
  else if (LOOKS_HTML_RE.test(t)) t = stripHtml(t);
  return decodeEntities(t)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Stable short id for a message: hash of its Message-ID, else of
// date + sender + subject.
function messageKey(msg = {}) {
  const basis = msg.messageId || `${msg.date || ""}|${msg.from || ""}|${msg.subject || ""}`;
  return crypto.createHash("sha1").update(String(basis)).digest("hex").slice(0, 16);
}

// Compact record for `--export-messages` (read by an LLM extraction pass).
function exportRecord(msg = {}, { excerptChars = 1500 } = {}) {
  const c = classifyMessage(msg);
  const rec = {
    id: messageKey(msg),
    date: toIsoDate(msg.date),
    from: { name: msg.fromName || "", address: msg.fromAddress || "" },
    to: msg.to || "",
    folder: msg.folder || "",
    subject: decodeEntities(msg.subject || ""),
    status: c.filtered ? "Filtered" : c.event || "Other",
    calendar: Boolean(msg.calendar),
    excerpt: plainText(msg.body || "").slice(0, excerptChars),
  };
  // Deterministic template decision (null → needs the LLM / human pass).
  rec.auto = templateExtract(rec);
  return rec;
}

function cleanText(s) {
  return decodeEntities(s)
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
  /\b(manager|engineer|director|lead|analyst|product|designer|head|vp|owner|specialist|scientist|marketing|growth|operations|developer|architect|consultant|associate|coordinator|strategist|researcher|president|officer|principal|staff|senior|intern|pm|program|project|chief|partner|representative|administrator|advisor|writer|editor|technician)\b/i;

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

// Words that only occur in prose, never in a job title: a capture containing
// them is a sentence fragment ("CrowdStrike, and we wish you success in your").
const FRAGMENT_RE =
  /\b(we|we're|you|your|our|us|wish|wishes|best|success|thank|thanks|please|will|would|unfortunately|decided|received|regret|hope|appreciate|which|been|have|has|was|were|is|are|am)\b|,\s*and\b/i;

// Prose wrapped around a title by greedy body captures:
// "Acme and for applying to the Senior PM" → "Senior PM",
// "Staff PM role here" → "Staff PM", "for the Product Designer" → "Product Designer".
function stripTitleProse(s) {
  return tidy(
    String(s || "")
      .replace(
        /^.*?\b(?:applying|apply|considering|consider|interest in)\s+(?:(?:to|for|in)\s+)?(?:the|our|a|an)\s+/i,
        ""
      )
      .replace(/^(?:(?:for|open|role of|job of|position of|position as)\s+)+(?:the\s+)?/i, "")
      .replace(/\s+(?:role|position|opening|opportunity|job)(?:\s+here)?$/i, "")
      .replace(/\s+here$/i, "")
  );
}

function validTitle(raw) {
  let t = tidy(stripReqId(tidy(stripTitleProse(tidy(decodeEntities(raw))))));
  t = tidy(t.replace(new RegExp(`\\s+${POS_WORD}$`, "i"), ""));
  // "interest in Acme and the Senior PM role": drop the company lead-in.
  const lead = t.match(/^(?<a>.+?)\s+(?:and|for)\s+the\s+(?<b>.+)$/i);
  if (lead && !ROLE_WORD_RE.test(lead.groups.a) && ROLE_WORD_RE.test(lead.groups.b)) {
    t = tidy(lead.groups.b);
  }
  // Cut mid-sentence: "Acme for the", "Acme's open".
  if (/\b(?:the|for|and|of|to|a|an|in|at|with|open)$/i.test(t)) return null;
  if (t.length < 2 || t.length > 120) return null;
  if (t.split(" ").length > 14) return null;
  if (LEADING_STOP_RE.test(t)) return null;
  if (/\b(application|candidacy|interest)\b/i.test(t)) return null;
  if (FRAGMENT_RE.test(t)) return null;
  // A title either names a role, or is a short capitalised name ("Product Lead").
  if (!ROLE_WORD_RE.test(t) && !(/^[A-Z0-9]/.test(t) && t.split(" ").length <= 6)) return null;
  if (!/[A-Z]/.test(t)) return null; // all-lowercase prose ("open")
  return t;
}

// Leading "DoNotReply-WorkdayNotifications", trailing "Talent Acquisition",
// "Recruiting", "Careers", "Support"... — sender-name noise around a company.
const COMPANY_LEAD_NOISE_RE = /^(?:do-?not-?reply|no-?reply|notifications?)[\w.-]*\s*[-–—|:]?\s*/i;
const COMPANY_TAIL_NOISE_RE =
  /\s*(?:[-–—|@,:]\s*)?\b(?:hiring team|recruiting team|recruitment team|talent acquisition(?: team)?|talent team|people team|hr team|human resources|people ops|recruiting|recruitment|recruiter|careers?|jobs|hiring|team|support|notifications?|no-?reply|workday|via\s+\w+)\s*$/i;

function stripCompanyNoise(raw) {
  let c = tidy(decodeEntities(raw)).replace(COMPANY_LEAD_NOISE_RE, "");
  for (let i = 0; i < 4; i += 1) {
    const next = c.replace(COMPANY_TAIL_NOISE_RE, "");
    if (next === c) break;
    c = next;
  }
  return tidy(c);
}

// `loose`: the capture comes from a structured slot (an ATS subject template),
// so lowercase-led brands are accepted ("refurbed", "eMoney Advisor", "iHerb").
function validCompany(raw, { loose = false } = {}) {
  const c = stripCompanyNoise(String(raw || "").replace(/[\u200e\u200f\u202a-\u202e]/g, ""));
  if (c.length < 1 || c.length > 60) return null;
  if (c.split(" ").length > 6) return null;
  // Original case survives the /i regexes: a company starts with a capital
  // letter or a digit ("the Senior PM role" is prose, "The Home Depot" is a name).
  if (!(loose ? /^[\p{L}\p{N}]/u : /^[\p{Lu}\p{N}]/u).test(c)) return null;
  if (loose && /^(?:the|a|an|our|your|this|that|us|you)\b/.test(c)) return null;
  if (/^(?:Our|Your|This|That|Us|You|We|It|My|Any|All)\b/.test(c)) return null;
  if (COMPANY_REJECT_RE.test(c)) return null;
  if (TITLE_SHAPE_RE.test(c)) return null;
  if (GENERIC_SENDER_RE.test(c)) return null;
  return c;
}

// "Senior PM at Acme" / "Acme - Senior PM" / "Senior PM" / "Acme".
function splitRest(rest) {
  const r = tidy(stripReqId(rest));
  let m = r.match(/^(?<t>.+?)\s+(?:at|with|@)\s+(?<c>.+)$/i);
  if (m) return { t: m.groups.t, c: m.groups.c };
  m = r.match(/^(?<a>.+?)\s+[-–—|:]\s+(?<b>.+)$/);
  if (m) {
    const aRole = ROLE_WORD_RE.test(m.groups.a);
    const bRole = ROLE_WORD_RE.test(m.groups.b);
    // "Senior PM - Document Platform": the suffix is usually part of the
    // title (team / product area), not the company.
    if (aRole && !bRole) return { t: r };
    if (bRole && !aRole) return { t: m.groups.b, c: m.groups.a };
    return {};
  }
  return ROLE_WORD_RE.test(r) ? { t: r } : { c: r };
}

function foldAscii(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// "Pat Lee" sending from plee@ / pat.lee@ / pat@ — a 2–3 word display name
// one of whose words is part of the address' local part.
function looksLikePerson(name, address) {
  const words = foldAscii(name)
    .split(/\s+/)
    .filter((w) => /^[a-z'-]{2,}$/.test(w));
  if (words.length < 2 || words.length > 3) return false;
  if (String(name).split(/\s+/).length !== words.length) return false;
  // ATS tenant addresses ("acme@myworkday.com") carry the company, not a person.
  if (isATS(address)) return false;
  const local = foldAscii(String(address || "").split("@")[0]).replace(/[^a-z]/g, "");
  return (
    Boolean(local) && words.some((w) => w.length >= 3 && local.includes(w.replace(/[^a-z]/g, "")))
  );
}

function companyFromSender(from) {
  const raw = String(from || "");
  let name = String(extractSenderName(raw) || "").replace(/^"+|"+$/g, "");
  // "Dani from Acme Kidney Care" → "Acme Kidney Care"
  const via = name.match(/\bfrom\s+(.+)$/i);
  if (via) name = via[1];
  const cleaned = tidy(name.replace(SENDER_NOISE_RE, ""));
  const addr0 = (raw.match(/<([^>]+)>/) || [null, raw])[1];
  // A recruiter's own name ("Pat Lee <plee@acme.com>") is not the company:
  // skip it and fall through to the address domain.
  const fromName = looksLikePerson(cleaned, addr0) ? null : validCompany(cleaned);
  if (fromName) return fromName;
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
  const b = cleanText(plainText(body)).slice(0, 5000);
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
    .replace(/\b(?:remote|hybrid|on ?site)\b/g, " ")
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

// Like appKey, but an empty title is allowed: a company-only row
// ("<company>::") still counts for the company cap.
function groupKey(company, title, aliasIndex) {
  const c = companyKey(company, aliasIndex);
  if (!c) return null;
  return `${c}::${looseTitle(title || "")}`;
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

// ---------- Deterministic templates over export records ----------
//
// `templateExtract(record)` reads one `exportRecord` and returns a decision
// for the reliable templates only:
//   { status: Ignore|Account|Applied|Rejected|Closed, company, title, rule }
// or null when the message needs a human / LLM look (interview claims,
// unclassified mail, no company found, the candidate's own sent mail,
// acknowledgements filed under a rejections folder). The folder is a hint:
// a "Rejections" folder confirms the classifier's rejection, newsletters and
// LinkedIn notifications are ignored, verification / password-reset /
// security-code mails are account signals.

const SUBJECT_COMPANY_RULES = [
  // "Thank you for applying to Acme!", "Pat, Thanks for your interest in Acme",
  // "Thank you for your application to Acme - Senior PM"
  /^(?:\W*\w+\s*[,|:]\s*)?(?:🎉|✅|\W)*\s*(?:thank you|thanks)(?: so much)?[,!]?\s+for (?:applying|your (?:job |online |recent )?application|your (?:job )?interest|your submission)(?: (?:to|in|with|at|for))\s+(?:the\s+|working at\s+|joining\s+)?(?<c>.+)$/i,
  // "Thank you from Acme", "Update from Acme", "An update from Acme | Senior PM"
  /^(?:\W*\w+\s*[,|:]\s*)?(?:thank you|(?:an )?update|follow-?up|a message|news|note) from\s+(?<c>.+)$/i,
  // "Your application to Acme", "Important information about your application to Acme",
  // "Update on your application at Acme", "Regarding your application with Acme"
  /^(?:(?:important )?information about|(?:an )?update (?:on|about|regarding)|regarding|we've got an update on|news about)?\s*your (?:job )?application (?:to|at|with)\s+(?<c>.+)$/i,
  // "You applied to Acme - Thank you!", "We received your application to Acme"
  /^(?:you applied|we(?:'ve|’ve| have)? received your application) to\s+(?<c>.+)$/i,
  // "Update on your Acme application", "Your Acme application: Next Steps"
  /^(?:(?:an )?update on |your )(?<c>[A-Z][\w&'’.\- ]{1,40}?) (?:job )?applications?\b/i,
  // "Acme | Application Confirmation", "Acme - Application Update",
  // "Acme: We received your job application!", "[Acme] Thank you for applying",
  // "Acme // Application Received", "Acme Application Status"
  /^\[?(?<c>[A-Z][^|:[\]/]{1,40}?)\]?\s*(?:\||:|\/\/|-|–|—)?\s*(?:application (?:confirmation|update|received|status)|job application (?:confirmation|status)|thank(?:s| you) for (?:applying|your application|your interest)|we (?:have )?received your (?:job )?application)\b/,
  /^(?<c>[A-Z][\w&'’.\- ]{1,40}?) (?:application status|job application confirmation)$/i,
];

// Trailing noise after the company in a subject capture.
function cleanSubjectCompany(raw) {
  let c = String(raw || "")
    .replace(/\s*[!.?]+\s*$/, "")
    .replace(/,\s*\w+\s*[!.]?$/, "") // ", Pat!"
    .replace(/\s*[-–—|:]\s*(?:thank you|thanks|application|next steps).*$/i, "")
    .replace(/\s*\((?:formerly|fka|f\.k\.a\.)[^)]*\)/i, "")
    .replace(/\s+(?:was|has been) received\b.*$/i, "")
    .replace(/\s+[-–—]\s+still under review$/i, "")
    .replace(/(?:\s|\p{Extended_Pictographic}|\u200d|\ufe0f)+$/u, "")
    .trim();
  // "Acme - Senior PM" / "Acme | Senior PM": keep the company side.
  const m = c.match(/^(?<a>.+?)\s+(?:[-–—|:]|for|on)\s+(?<b>.+)$/i);
  let title = null;
  if (m && (ROLE_WORD_RE.test(m.groups.b) || /\b(?:R|JR|REQ)[-_]?\d{3,}/.test(m.groups.b))) {
    c = m.groups.a;
    title = m.groups.b;
  }
  return { company: c, title };
}

function companyFromSubject(subject) {
  const s = decodeEntities(subject || "")
    .replace(/^(?:re|fwd?):\s*/gi, "")
    .trim();
  for (const re of SUBJECT_COMPANY_RULES) {
    const m = s.match(re);
    if (!m || !m.groups || !m.groups.c) continue;
    const { company, title } = cleanSubjectCompany(m.groups.c);
    const vc = validCompany(company, { loose: true });
    if (vc) return { company: vc, title: title ? validTitle(title) : null };
  }
  return null;
}

// Workday tenant slug from an activation URL or a tenant sender address.
function workdayTenant(rec) {
  const text = `${rec.excerpt || ""}`;
  const u = text.match(/https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs)?\.com/i);
  if (u) return u[1];
  const addr = String((rec.from && rec.from.address) || "").toLowerCase();
  const m = addr.match(/^([a-z0-9_-]+)@(?:otp\.)?(?:my)?workday\.com$/);
  if (m && !GENERIC_SENDER_RE.test(m[1])) return m[1];
  const d = addr.match(/^myworkday@([a-z0-9-]+)\./);
  if (d) return d[1];
  return null;
}

function titleCaseSlug(slug) {
  return String(slug || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

// Subject captures that are template filler, not a company
// ("Thank You for Applying – Stay Tuned!", "Update on your Application Status").
const SUBJECT_FILLER_RE =
  /^(?:let[’']?s stay (?:connected|in touch)|here[’']?s what to expect(?: next)?|what[’']?s next|stay tuned|next steps?|update on your|confirmation of|unlock\b.*|still under review)$/i;

// The first name a message greets ("Hi Pat," / "Dear Pat") — never a company.
function greetedName(text) {
  const m = String(text || "")
    .slice(0, 300)
    .match(
      /(?:^|[\s,.!])(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|HI|HELLO|HEY|DEAR)\s+([\p{Lu}][\p{L}'’-]+)/u
    );
  return m ? m[1].toLowerCase() : null;
}

// The classifier reads an acknowledgement's hedge ("we may not respond if
// there is not a match") as a rejection, and a rejection that opens with
// "Thank you for applying" as an acknowledgement. Settle both on explicit
// phrases; anything without one keeps the classifier's call.
const CLOSED_TEXT_RE =
  /\b(?:(?:position|role|opportunity|requisition|job|opening)s? (?:has|have) (?:now )?been (?:filled|closed|cancell?ed|put on hold)|(?:position|role|opportunity|requisition|job|opening) (?:was|is) (?:now )?(?:filled|closed|cancell?ed|on hold)|(?:have )?(?:officially )?filled (?:the|this|that) (?:position|role|opportunity)|filled this opportunity|no longer (?:hiring|accepting applications|available|open)|decided (?:not to fill|to pause|to close)|pause(?:d)? (?:hiring|on the)|close our search|cancell?ed (?:the|this) (?:position|role|requisition))/i;
const REJECTED_TEXT_RE =
  /\b(?:decided (?:not to (?:move|proceed|pursue|advance|progress)|to (?:move|proceed|go) forward with (?:other|another))|(?:will|are|were) not (?:be )?(?:moving|move|proceed(?:ing)?|progress(?:ing)?|advanc(?:e|ing))|won[’']t be (?:moving|proceeding|progressing)|not (?:be )?(?:moving|move|proceed(?:ing)?) forward|mov(?:e|ed|ing) forward with (?:other|another)|pursue other candidates|other (?:candidates|applicants) (?:who|whose|that)|(?:were|was|have|has) not (?:been )?selected|not been selected|regret to inform|(?:are|is|were|was) not (?:the right|a good|a strong) fit\b|more closely (?:match|align)|not (?:be )?progressing|(?:will|are) not (?:be )?(?:considering|consider) your)/i;

function refineEvent(event, text, folder) {
  const t = String(text || "");
  if (CLOSED_TEXT_RE.test(t)) return "Closed";
  if (event === "Applied" && REJECTED_TEXT_RE.test(t)) return "Rejected";
  if (
    event === "Rejected" &&
    folder !== "rejections" &&
    !REJECTED_TEXT_RE.test(t) &&
    !/\bunfortunately\b/i.test(t) &&
    /\b(?:received your application|have received|application has been received|what happens next|will (?:be )?review|reviewing (?:your|all|applications))/i.test(
      t
    )
  ) {
    return "Applied";
  }
  return event;
}

const ACCOUNT_SUBJECT_RE =
  /verify your candidate account|reset your password for your candidate account|candidate account|security code for your application/i;

function templateExtract(rec = {}) {
  const folder = String(rec.folder || "").toLowerCase();
  const subject = decodeEntities(rec.subject || "");
  const status = rec.status;
  const fromStr = rec.from
    ? `${rec.from.name ? `"${rec.from.name}" ` : ""}<${rec.from.address || ""}>`
    : "";

  if (status === "Filtered") return { status: "Ignore", company: "", title: "", rule: "filtered" };
  if (folder === "linkedin" && !/application/i.test(subject)) {
    return { status: "Ignore", company: "", title: "", rule: "linkedin_notification" };
  }
  if (folder === "newsletter" && status !== "Applied") {
    return { status: "Ignore", company: "", title: "", rule: "newsletter" };
  }

  // Account signals.
  const sec = subject.match(/security code for your application to\s+(.+)$/i);
  if (sec) {
    const c = validCompany(
      sec[1].replace(/\s+(?:linkedin\s+)?(?:job\s+)?board$/i, "").replace(/[!.]+$/, ""),
      { loose: true }
    );
    return c
      ? { status: "Account", company: c, title: "", rule: "security_code" }
      : { status: "Ignore", company: "", title: "", rule: "security_code_no_company" };
  }
  if (
    ACCOUNT_SUBJECT_RE.test(subject) ||
    folder === "verifications" ||
    folder === "password reset"
  ) {
    const t = workdayTenant(rec);
    return t
      ? { status: "Account", company: titleCaseSlug(t), title: "", rule: "workday_account" }
      : null;
  }

  if (folder === "sent") return null;
  let event = null;
  if (folder === "rejections") {
    if (status === "Rejected" || status === "Closed") event = status;
  } else if (status === "Applied" || status === "Rejected" || status === "Closed") {
    event = status;
  }
  if (!event) return null; // Interview claims, unclassified, misfiled acks → review
  event = refineEvent(event, rec.excerpt, folder);

  const greeted =
    greetedName(rec.excerpt) ||
    greetedName(subject.replace(/^(\S+),(?=\s+(?:thank|thanks|we|your)\b)/i, "hi $1,"));
  const usable = (c) =>
    Boolean(c) && !SUBJECT_FILLER_RE.test(c) && !(greeted && c.toLowerCase() === greeted);
  const subj = companyFromSubject(subject);
  const ex = extractCompanyTitle({ subject, from: fromStr, body: rec.excerpt || "" });
  let company = null;
  let rule = null;
  const tenant = workdayTenant(rec);
  for (const [c, r] of [
    [subj && subj.company, "subject"],
    [ex.companySource === "text" ? ex.company : null, "body"],
    [ex.companySource === "sender" ? ex.company : null, "sender"],
    [tenant ? titleCaseSlug(tenant) : null, "workday_tenant"],
  ]) {
    if (usable(c)) {
      company = c;
      rule = r;
      break;
    }
  }
  if (!company) return null;
  let title = (rule === "subject" && subj.title) || ex.title || "";
  // "Acme's Senior PM" → "Senior PM"; a URL is never a title.
  if (title.toLowerCase().startsWith(`${company.toLowerCase()}'s `)) {
    title = title.slice(company.length + 3);
  } else if (title.toLowerCase().startsWith(`${company.toLowerCase()}’s `)) {
    title = title.slice(company.length + 3);
  }
  if (/:\/\/|\bwww\./i.test(title)) title = "";
  if (title && normalizeTitle(title) === normalizeTitle(company)) title = "";
  return { status: event, company, title, rule };
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
    if (!row.apply_note && ad) patch.apply_note = noteFor(summary);
  }
  return patch;
}

// Provenance note: "<source>:<applied date>", e.g. "zoho:2025-03-03",
// "linkedin:2025-03-03", "account:2025-03-03".
function noteFor(summary) {
  const prefix = (summary && summary.note) || NOTE_PREFIX;
  const ad = summary && summary.appliedDate;
  return ad ? `${prefix}:${ad}` : prefix;
}

// ---------- Plan ----------

// Same-day tie-break: an invite follows the acknowledgement, a terminal
// answer follows the invite (dates are day-granular, mail order is not).
const EVENT_RANK = { Applied: 0, Interview: 1, Offer: 2, Rejected: 3, Closed: 3 };

function summarizeEvents(events) {
  const rank = (e) => EVENT_RANK[e.event] ?? 0;
  const sorted = events
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b)));
  const dated = sorted.filter((e) => e.date);
  const acks = dated.filter((e) => e.event === "Applied");
  const first = acks[0] || dated[0] || {};
  const appliedDate = first.date || "";
  const progress = sorted.filter((e) => e.event !== "Applied");
  const status = progress.length ? progress[progress.length - 1].event : "Applied";
  const out = {
    status,
    appliedDate,
    events: sorted.map((e) => ({ date: e.date, event: e.event, subject: e.subject })),
  };
  if (first.note) out.note = first.note;
  return out;
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

// Build-plan context shared by the heuristic path (buildPlan) and the
// LLM-extracted path (buildPlanFromExtracted).
function newPlanContext(apps, opts = {}) {
  const aliasIndex = buildAliasIndex(opts.companyAliases);
  const rowIndex = new Map();
  const rowsByCompany = new Map();
  for (const row of apps) {
    const k = groupKey(row.companyName, row.title, aliasIndex);
    if (k && !rowIndex.has(k)) rowIndex.set(k, row);
    const ck = companyKey(row.companyName, aliasIndex);
    if (ck) {
      if (!rowsByCompany.has(ck)) rowsByCompany.set(ck, []);
      rowsByCompany.get(ck).push(row);
    }
  }
  return {
    since: opts.since || "",
    now: opts.now || new Date().toISOString(),
    aliasIndex,
    rowIndex,
    rowsByCompany,
    groups: new Map(), // groupKey → { companies[], titles[], events[] }
    companyOnly: [],
    unparseable: [],
    unclassifiedAts: [],
    stats: {
      scanned: 0,
      filtered: 0,
      outOfRange: 0,
      duplicates: 0,
      ignored: 0,
      classified: { Applied: 0, Rejected: 0, Interview: 0, Closed: 0, OTHER: 0 },
      matchedRows: 0,
      updates: 0,
      unchanged: 0,
      newRows: 0,
      companyOnlyRows: 0,
      companyOnlyMerged: 0,
      unparseable: 0,
      notionLinkedUpdates: 0,
    },
  };
}

function addToGroup(ctx, company, title, ev) {
  const k = groupKey(company, title, ctx.aliasIndex);
  if (!k) return false;
  if (!ctx.groups.has(k)) ctx.groups.set(k, { companies: [], titles: [], events: [] });
  const g = ctx.groups.get(k);
  g.companies.push(company);
  g.titles.push(title || "");
  g.events.push(ev);
  return true;
}

// Title-less messages: attach to the single titled group of that company in
// this import, else to the single applied-like TSV row of that company.
// `keepUnanchored` (extracted path): a company with no group and no applied
// row becomes its own title-less row — it still counts for the company cap.
// The heuristic path lists such messages as unparseable instead.
function resolveCompanyOnly(ctx, { keepUnanchored = false } = {}) {
  for (const { company, ev } of ctx.companyOnly) {
    const ck = companyKey(company, ctx.aliasIndex);
    const sameCompany = [...ctx.groups.keys()].filter(
      (k) => k.startsWith(`${ck}::`) && k !== `${ck}::`
    );
    if (sameCompany.length === 1) {
      ctx.groups.get(sameCompany[0]).events.push(ev);
      continue;
    }
    const applied = (ctx.rowsByCompany.get(ck) || []).filter((r) => APPLIED_LIKE.has(r.status));
    const ackOk = keepUnanchored || ev.event !== "Applied";
    if (sameCompany.length === 0 && applied.length === 1 && ackOk) {
      addToGroup(ctx, applied[0].companyName, applied[0].title, ev);
      continue;
    }
    if (keepUnanchored) {
      if (sameCompany.length === 0 && applied.length === 0) {
        addToGroup(ctx, company, "", ev);
      } else {
        // The company is already represented by a titled row; which one this
        // message belongs to is unknown, and the cap already counts it.
        ctx.stats.companyOnlyMerged += 1;
      }
      continue;
    }
    ctx.unparseable.push({
      subject: ev.subject,
      date: ev.date,
      event: ev.event,
      reason: sameCompany.length > 1 || applied.length > 1 ? "ambiguous_title" : "no_title",
    });
  }
}

function finalizePlan(ctx, extra = {}) {
  const { stats } = ctx;
  const updates = [];
  const appends = [];
  const unchanged = [];
  for (const [k, g] of ctx.groups) {
    const summary = summarizeEvents(g.events);
    const row = ctx.rowIndex.get(k);
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
      const companyName = mostCommon(g.companies) || "";
      const title = mostCommon(g.titles) || "";
      const jobId = syntheticJobId(companyName, title);
      const ad = summary.appliedDate || "";
      stats.newRows += 1;
      if (!title) stats.companyOnlyRows += 1;
      appends.push({
        key: makeKey(LEGACY_SOURCE, jobId),
        source: LEGACY_SOURCE,
        jobId,
        companyName,
        title,
        url: "",
        status: summary.status,
        applied_date: ad,
        applied_by: APPLIED_BY,
        apply_state: APPLY_STATE,
        apply_note: noteFor(summary),
        summary,
      });
    }
  }
  stats.unparseable = ctx.unparseable.length;
  return {
    version: 1,
    kind: "legacy_mail_import",
    createdAt: ctx.now,
    since: ctx.since,
    ...extra,
    stats,
    updates,
    appends,
    unchanged,
    unparseable: ctx.unparseable,
    unclassifiedAts: ctx.unclassifiedAts,
  };
}

// Build the import plan from raw messages with the heuristic extractor. Pure.
//   apps      — current TSV rows (applications_tsv.load().apps)
//   messages  — [{ messageId, subject, from, body, date }]
//   opts      — { since: "YYYY-MM-DD", companyAliases, now }
function buildPlan(apps, messages, opts = {}) {
  const ctx = newPlanContext(apps, opts);
  const { stats } = ctx;
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
    if (ctx.since && date && date < ctx.since) {
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
      if (isATS(msg.from || "")) ctx.unclassifiedAts.push({ subject: msg.subject || "", date });
      continue;
    }
    stats.classified[c.event] += 1;
    const ex = extractCompanyTitle(msg);
    const ev = { date, event: c.event, subject: msg.subject || "" };
    if (ex.company && ex.title) addToGroup(ctx, ex.company, ex.title, ev);
    else if (ex.company) ctx.companyOnly.push({ company: ex.company, ev });
    else ctx.unparseable.push({ subject: ev.subject, date, event: c.event, reason: "no_company" });
  }
  resolveCompanyOnly(ctx, { keepUnanchored: false });
  return finalizePlan(ctx);
}

// `Account` = an ATS account-verification / password-reset mail: evidence of
// an application to that company only when nothing else names one.
const EXTRACTED_STATUSES = new Set([
  "Applied",
  "Rejected",
  "Interview",
  "Closed",
  "Account",
  "Ignore",
]);

// Validate one record of an `--extracted` file. Returns an error string or null.
function validateExtracted(r) {
  if (!r || typeof r !== "object") return "not an object";
  if (!EXTRACTED_STATUSES.has(r.status)) return `bad status ${JSON.stringify(r.status)}`;
  if (r.status === "Ignore") return null;
  if (!r.company || typeof r.company !== "string" || !r.company.trim()) return "missing company";
  if (r.title !== undefined && r.title !== null && typeof r.title !== "string") return "bad title";
  if (!toIsoDate(r.date)) return "bad date";
  return null;
}

// Build the import plan from LLM-extracted records instead of the heuristic
// extractor. Same matching / merge / plan shape as buildPlan. Pure.
//   records — [{ id, company, title,
//                status: Applied|Rejected|Interview|Closed|Account|Ignore,
//                date, subject?, note? }]
// `note` ("linkedin", ...) becomes the apply_note prefix (default "zoho").
// Title "" keeps a company-only row (it still counts for the company cap).
function buildPlanFromExtracted(apps, records, opts = {}) {
  if (!Array.isArray(records)) throw new Error("extracted file must be a JSON array");
  const ctx = newPlanContext(apps, opts);
  const { stats } = ctx;
  stats.accountRows = 0;
  stats.accountIgnored = 0;
  const accounts = [];
  const seenIds = new Set();
  for (const r of records) {
    stats.scanned += 1;
    const id = r && r.id ? String(r.id) : "";
    if (id) {
      if (seenIds.has(id)) {
        stats.duplicates += 1;
        continue;
      }
      seenIds.add(id);
    }
    const err = validateExtracted(r);
    const subject = (r && r.subject) || (id ? `id:${id}` : "");
    const date = toIsoDate(r && r.date);
    if (err) {
      ctx.unparseable.push({ subject, date, event: (r && r.status) || "", reason: err });
      continue;
    }
    if (r.status === "Ignore") {
      stats.ignored += 1;
      continue;
    }
    if (ctx.since && date < ctx.since) {
      stats.outOfRange += 1;
      continue;
    }
    const company = r.company.trim();
    const title = String(r.title || "").trim();
    if (r.status === "Account") {
      accounts.push({ company, ev: { date, event: "Applied", subject, note: "account" } });
      continue;
    }
    stats.classified[r.status] += 1;
    const ev = { date, event: r.status, subject };
    if (r.note) ev.note = String(r.note);
    if (title) addToGroup(ctx, company, title, ev);
    else ctx.companyOnly.push({ company, ev });
  }
  resolveCompanyOnly(ctx, { keepUnanchored: true });
  // Account-creation mails count only for companies nothing else names.
  for (const { company, ev } of accounts) {
    const ck = companyKey(company, ctx.aliasIndex);
    const named =
      [...ctx.groups.keys()].some((k) => k.startsWith(`${ck}::`)) ||
      (ctx.rowsByCompany.get(ck) || []).some((r) => APPLIED_LIKE.has(r.status));
    const own = ctx.groups.get(`${ck}::`);
    if (named && !(own && own.account)) {
      stats.accountIgnored += 1;
      continue;
    }
    if (!own) stats.accountRows += 1;
    addToGroup(ctx, company, "", ev);
    ctx.groups.get(`${ck}::`).account = true;
  }
  return finalizePlan(ctx, { extracted: true });
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
      Object.assign(fresh, {
        applied_date: a.summary.appliedDate || "",
        applied_by: APPLIED_BY,
        apply_state: APPLY_STATE,
        apply_note: a.apply_note || noteFor(a.summary),
      });
      rows = out.apps;
      byKey.set(fresh.key, fresh);
      result.appended += 1;
      continue;
    }
    // Fuzzy duplicate of an existing row → fold into it.
    const fk = fuzzyKey(job);
    const dup = fk ? rows.find((r) => fuzzyKey(r) === fk) : null;
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
  lines.push(
    `new rows: ${s.newRows}` + (s.companyOnlyRows ? ` (company-only: ${s.companyOnlyRows})` : "")
  );
  if (plan.extracted) {
    lines.push(
      `ignored: ${s.ignored}, title-less merged into a titled row: ${s.companyOnlyMerged}, ` +
        `account-only rows: ${s.accountRows || 0} (account mails ignored: ${s.accountIgnored || 0})`
    );
  }
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
      `Note: ${s.notionLinkedUpdates} updated row(s) have a Notion page. With --apply, the ones whose ` +
        "status changes get the same status in Notion (so the next `sync` pull keeps the import)."
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
  groupKey,
  decodeEntities,
  plainText,
  messageKey,
  exportRecord,
  templateExtract,
  companyFromSubject,
  workdayTenant,
  validTitle,
  validCompany,
  buildPlanFromExtracted,
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
