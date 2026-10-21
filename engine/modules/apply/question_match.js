// Deterministic question → answer mapping for application forms (RFC 068 §4).
//
// `matchQuestion(field, ctx)` maps one form field to:
//   { source: "identity", value }   — name / email / phone / location / LinkedIn
//   { source: "defaults", value }   — work authorization, sponsorship,
//                                     relocation, EEO, how-did-you-hear, country
//   { source: "salary",   value }   — desired salary (§4a, via ctx.salary)
//   { source: "file",     value }   — "resume" | "cover_letter"
//   null                            — not a standard question (bank / LLM step)
//
// No LLM: normalized label text + synonym tables. For select / radio fields
// the value is the exact option text to pick; when no option fits, the
// match is dropped (null) rather than guessing.
//
// ctx = {
//   identity:      profile.identity { name, phone, location, email, linkedin, website? }
//   applyDefaults: profile.applyDefaults (shape in RFC 068 §4)
//   salary:        result of salary.computeDesiredSalary() or null
// }

const { salaryAnswer } = require("./salary.js");

function normalizeLabel(label) {
  return String(label || "")
    .toLowerCase()
    .replace(/[✱*]/g, " ")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'/+& -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOption(opt) {
  return String(opt || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Options that mean "I decline to self-identify" across ATSes.
const DECLINE_RE =
  /\b(decline|prefer not|don't wish|do not wish|not wish to|choose not|rather not|do not want|don't want|not to (say|answer|disclose|self identify)|i don't know|no answer|undisclosed)\b/;

// Pick the option that best expresses `wanted`. Strategy: exact normalized
// match → option starting with wanted → option containing wanted (as a whole
// phrase). For yes/no answers, options like "Yes, I am authorized" count.
// Returns the original option text or null.
function pickOption(options, wanted) {
  const list = Array.isArray(options) ? options.filter((o) => String(o || "").trim()) : [];
  if (!list.length) return null;
  const w = normalizeOption(wanted);
  if (!w) return null;
  const norm = list.map((o) => ({ raw: o, n: normalizeOption(o) }));
  const exact = norm.find((o) => o.n === w);
  if (exact) return exact.raw;
  const starts = norm.filter((o) => o.n.startsWith(`${w} `) || o.n.startsWith(w));
  if (starts.length === 1) return starts[0].raw;
  if (starts.length > 1) {
    // Prefer the shortest (most literal) option: "No" over "No, but ...".
    return starts.sort((a, b) => a.n.length - b.n.length)[0].raw;
  }
  if (w.length >= 4) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const contains = norm.filter((o) => re.test(o.n));
    if (contains.length) return contains.sort((a, b) => a.n.length - b.n.length)[0].raw;
  }
  return null;
}

function pickDeclineOption(options) {
  const list = Array.isArray(options) ? options : [];
  const hit = list.find((o) => DECLINE_RE.test(normalizeOption(o)));
  return hit || null;
}

function splitName(full) {
  const parts = String(full || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function hasOptions(field) {
  return Array.isArray(field.options) && field.options.length > 0;
}

function isChoice(field) {
  return field.type === "select" || field.type === "radio" || field.type === "checkbox";
}

// Resolve a free value against the field: choice fields must map to one of
// the options, text fields take the value as-is.
function resolveValue(field, value) {
  if (value == null || value === "") return null;
  if (isChoice(field) && hasOptions(field)) return pickOption(field.options, value);
  return String(value);
}

function yesNo(bool) {
  return bool ? "Yes" : "No";
}

// --- matchers ---------------------------------------------------------------
// Each matcher: (label, field, ctx) → {source, value} | null | undefined.
// `undefined` = not my question, keep looking; `null` = my question, but no
// answer can be produced (stop — do not let a later, looser rule guess).

const FILE_RULES = [
  { re: /\bcover letter\b/, value: "cover_letter" },
  { re: /\b(resume|cv|curriculum vitae)\b/, value: "resume" },
];

function matchFile(label, field) {
  if (field.type !== "file") return undefined;
  for (const r of FILE_RULES) if (r.re.test(label)) return { source: "file", value: r.value };
  return null;
}

const EEO_RE =
  /\b(gender|sex|race|racial|ethnicity|ethnic|hispanic|latino|latinx|veteran|disability|disabled|sexual orientation|transgender|lgbtq)\b/;

function matchEeo(label, field, ctx) {
  if (!EEO_RE.test(label)) return undefined;
  // "Pronouns" and "gender identity" free-text fields both land here.
  const policy =
    (ctx.applyDefaults && ctx.applyDefaults.eeo && ctx.applyDefaults.eeo.policy) || "decline";
  if (policy !== "decline") return null;
  if (hasOptions(field)) {
    const opt = pickDeclineOption(field.options);
    return opt ? { source: "defaults", value: opt } : null;
  }
  if (field.type === "text" || field.type === "textarea") {
    return { source: "defaults", value: "Decline to self-identify" };
  }
  return null;
}

function matchPronouns(label, field) {
  if (!/\bpronouns?\b/.test(label)) return undefined;
  if (hasOptions(field)) {
    const opt = pickDeclineOption(field.options);
    return opt ? { source: "defaults", value: opt } : null;
  }
  return null;
}

function matchSponsorship(label, field, ctx) {
  if (!/\b(sponsor|sponsorship|visa|h-?1b|h1-b|immigration)\b/.test(label)) return undefined;
  const wa = (ctx.applyDefaults && ctx.applyDefaults.work_authorization) || null;
  if (!wa || typeof wa.requires_sponsorship !== "boolean") return null;
  const value = resolveValue(field, yesNo(wa.requires_sponsorship));
  return value ? { source: "defaults", value } : null;
}

function matchWorkAuth(label, field, ctx) {
  const isAuth =
    /\b(authori[sz]ed|authori[sz]ation|eligible to work|eligibility to work|right to work|legally (able|permitted|allowed)|permitted to work|lawfully)\b/.test(
      label
    );
  if (!isAuth) return undefined;
  const wa = (ctx.applyDefaults && ctx.applyDefaults.work_authorization) || null;
  if (!wa) return null;
  // Free-text "What is your work authorization status?" → status text.
  if (!isChoice(field) && /\bstatus\b/.test(label) && wa.status_text) {
    return { source: "defaults", value: wa.status_text };
  }
  if (typeof wa.authorized_us !== "boolean") return null;
  // Only answer for US authorization; a question about another country
  // is not covered by the defaults.
  if (
    /\b(canada|uk|united kingdom|europe|eu|germany|india|australia|singapore|ireland)\b/.test(label)
  ) {
    return null;
  }
  const value = resolveValue(field, yesNo(wa.authorized_us));
  return value ? { source: "defaults", value } : null;
}

function matchRelocation(label, field, ctx) {
  if (!/\b(relocat\w*)\b/.test(label)) return undefined;
  const rel = ctx.applyDefaults && ctx.applyDefaults.relocation;
  if (!rel || typeof rel.willing !== "boolean") return null;
  const value = resolveValue(field, yesNo(rel.willing));
  return value ? { source: "defaults", value } : null;
}

function matchHowHeard(label, field, ctx) {
  if (
    !/\b(how did you (hear|find|learn|come across)|where did you (hear|find|learn)|how did you discover|referral source|source of (your )?application|how were you referred)\b/.test(
      label
    )
  ) {
    return undefined;
  }
  const def = (ctx.applyDefaults && ctx.applyDefaults.how_did_you_hear_default) || "";
  if (!hasOptions(field)) return def ? { source: "defaults", value: def } : null;
  const direct = def ? pickOption(field.options, def) : null;
  if (direct) return { source: "defaults", value: direct };
  // Closest canonical buckets for "company careers page".
  for (const w of [
    "careers page",
    "company website",
    "career site",
    "website",
    "job board",
    "other",
  ]) {
    const opt = pickOption(field.options, w);
    if (opt) return { source: "defaults", value: opt };
  }
  return null;
}

function matchSalary(label, field, ctx) {
  if (
    !/\b(salary|compensation|pay expectations?|expected pay|desired pay|base pay|pay range|total comp|ote)\b/.test(
      label
    )
  ) {
    return undefined;
  }
  if (!ctx.salary) return null;
  if (isChoice(field)) return null; // bucketed salary selects go to the LLM step
  const wantsRange = /\brange\b|\bmin(imum)?\b.*\bmax(imum)?\b/.test(label);
  return { source: "salary", value: salaryAnswer(ctx.salary, { wantsRange }) };
}

function matchCountry(label, field, ctx) {
  if (!/^(country|country of residence|current country|phone country|country code)$/.test(label)) {
    return undefined;
  }
  const country = (ctx.applyDefaults && ctx.applyDefaults.country) || "United States";
  if (!hasOptions(field)) return { source: "defaults", value: country };
  const opt = pickOption(field.options, country);
  return opt ? { source: "defaults", value: opt } : null;
}

// "linkedin.com/in/x" → "https://linkedin.com/in/x" (URL inputs validate).
function withScheme(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

const IDENTITY_RULES = [
  {
    re: /^(legal |preferred )?first name$|^given name$|^first$/,
    pick: (id) => splitName(id.name).first,
  },
  {
    re: /^(legal )?last name$|^surname$|^family name$|^last$/,
    pick: (id) => splitName(id.name).last,
  },
  { re: /^(full |legal |your )?name$|^(full )?legal name$|^name full$/, pick: (id) => id.name },
  { re: /^e ?mail( address)?$|^your email$/, pick: (id) => id.email },
  {
    re: /^(phone|phone number|mobile|mobile phone|mobile number|cell|cell phone|telephone)$/,
    pick: (id) => id.phone,
  },
  { re: /\blinkedin\b/, pick: (id) => withScheme(id.linkedin) },
  {
    re: /^(website|personal website|portfolio|portfolio url|other website|website url)$/,
    pick: (id) => withScheme(id.website || id.portfolio || ""),
  },
  {
    re: /^(location|current location|location city|city|your location|where are you (currently )?located|current city|city and state|city state)$|from where do you intend to work|where do you plan on working from|where will you be working from/,
    pick: (id) => id.location,
  },
];

function matchIdentity(label, field, ctx) {
  const id = ctx.identity || {};
  for (const rule of IDENTITY_RULES) {
    if (!rule.re.test(label)) continue;
    const v = rule.pick(id);
    if (!v) return null;
    if (isChoice(field)) {
      const opt = hasOptions(field) ? pickOption(field.options, v) : null;
      return opt ? { source: "identity", value: opt } : null;
    }
    return { source: "identity", value: String(v) };
  }
  return undefined;
}

const MATCHERS = [
  matchFile,
  matchCountry,
  matchIdentity,
  matchEeo,
  matchPronouns,
  matchSponsorship,
  matchWorkAuth,
  matchRelocation,
  matchHowHeard,
  matchSalary,
];

function matchQuestion(field, ctx = {}) {
  if (!field) return null;
  const label = normalizeLabel(field.label);
  if (!label) return null;
  for (const m of MATCHERS) {
    const r = m(label, field, ctx);
    if (r === undefined) continue;
    return r;
  }
  return null;
}

module.exports = {
  matchQuestion,
  pickOption,
  pickDeclineOption,
  normalizeLabel,
  splitName,
};
