// Email security codes for the apply bot (RFC 068, BL-225).
//
// After the Submit click Greenhouse may hold the application and mail a
// one-time code to the address on the form ("Copy and paste this code into
// the security code field on your application: XXXXXXXX"). The address is the
// owner's own apply mailbox, so the bot reads the code there and types it in —
// owner decision 2026-10-21, same as his previous bot. Captchas are a
// different thing and still go to the human.
//
// Pure helpers + an injected `fetchMails` so the polling is testable. The IMAP
// fetcher at the bottom is the only side-effectful part.

const CODE_RE = /security code field[^:]{0,80}:\s*([A-Za-z0-9]{6,12})\b/i;
const FALLBACK_RE = /\b(?:security|verification) code[^:]{0,80}:\s*([A-Za-z0-9]{6,12})\b/i;
const SENDER_RE = /greenhouse/i;
const SUBJECT_RE = /security code/i;
// The mail can be stamped a little before our clock read the click time.
// Keep it short: a retry on the same job gets a new code, and the previous
// attempt's mail (a minute or two older) must not be taken for it — a live
// run did exactly that with a 2-minute slack and the code was refused.
const CLOCK_SLACK_MS = 20 * 1000;

function parseSecurityCode(mail) {
  const text = `${(mail && mail.body) || ""}\n${(mail && mail.snippet) || ""}`;
  const m = text.match(CODE_RE) || text.match(FALLBACK_RE);
  return m ? m[1] : null;
}

// "Security code for your application to BILL" → "BILL".
function subjectCompany(subject) {
  const m = String(subject || "").match(/application to\s+(.+?)\s*$/i);
  return m ? m[1] : "";
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// The mail names the employer as the ATS board knows it ("BILL"), the row as
// we know it ("Bill.com"). Containment either way, or the same first word.
function companyMatches(mailCompany, company) {
  const a = norm(mailCompany);
  const b = norm(company);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const first = (s) => norm(String(s || "").split(/[\s.,&-]+/)[0]);
  return first(mailCompany) !== "" && first(mailCompany) === first(company);
}

// Newest unused code mail for this company, sent after `sinceMs`.
function pickCodeMail(mails, { company, sinceMs, used }) {
  const fresh = (mails || [])
    .filter((m) => SENDER_RE.test(m.from || "") && SUBJECT_RE.test(m.subject || ""))
    .filter((m) => !used.has(m.rfcMessageId || m.messageId))
    .filter((m) => {
      const t = Date.parse(m.date || "");
      return Number.isFinite(t) && t >= sinceMs - CLOCK_SLACK_MS;
    })
    .filter((m) => companyMatches(subjectCompany(m.subject), company))
    .sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
  for (const m of fresh) {
    const code = parseSecurityCode(m);
    if (code) return { mail: m, code };
  }
  return null;
}

// "Thank you for applying" mail from the employer (or its ATS) after the
// click: the application went through even when the page did not show it.
const CONFIRM_RE =
  /thank(s| you) for (applying|your application|your interest)|application (was )?(received|submitted)|we(’|')ve received your application|received your application/i;

// Lower-case word tokens: "Thank You for Applying to Join BILL!" →
// ["thank", "you", …, "bill"]; "no-reply@hq.bill.com" → […, "bill", "com"].
function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Legal / domain suffixes that are not part of how a mail names the employer.
const NAME_NOISE = new Set(["inc", "llc", "ltd", "corp", "co", "com", "io", "ai", "the"]);

function hasSequence(words, seq) {
  if (!seq.length) return false;
  for (let i = 0; i + seq.length <= words.length; i++) {
    if (seq.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

// The mail is about this company when the whole name ("next insurance")
// appears as words anywhere in it, or its first word ("bill") appears as a
// word in the sender or the subject. A first word alone in the body is not
// enough: "Next Insurance" must not match "next steps" in another
// employer's mail (a live false match, 09.11.2026).
function mailNamesCompany(mail, company) {
  const name = tokens(company).filter((w) => !NAME_NOISE.has(w));
  if (!name.length) return false;
  const all = tokens(`${mail.from || ""} ${mail.subject || ""} ${mail.body || ""}`);
  if (hasSequence(all, name)) return true;
  const head = tokens(`${mail.from || ""} ${mail.subject || ""}`);
  return name[0].length > 1 && head.includes(name[0]);
}

function mailId(m) {
  return m.rfcMessageId || m.messageId || `${m.date || ""}|${m.from || ""}|${m.subject || ""}`;
}

// The employer's "thank you for applying" mail sent after `sinceMs`.
// `used` (a Set of mail ids) keeps one mail from confirming two rows. With a
// `title`, a mail that names the job title wins; `titleOnly` returns only
// such a mail (the first pass when one company has several rows).
function findConfirmation(mails, { company, sinceMs, title = "", used = null, titleOnly = false }) {
  if (!tokens(company).some((w) => !NAME_NOISE.has(w))) return null;
  const candidates = (mails || []).filter((m) => {
    const t = Date.parse(m.date || "");
    if (!Number.isFinite(t) || t < sinceMs - CLOCK_SLACK_MS) return false;
    if (SUBJECT_RE.test(m.subject || "")) return false; // a security code, not a confirmation
    if (used && used.has(mailId(m))) return false;
    return CONFIRM_RE.test(`${m.subject || ""}\n${m.body || ""}`) && mailNamesCompany(m, company);
  });
  const t = norm(title);
  const byTitle = t
    ? candidates.find((m) => norm(`${m.subject || ""} ${m.body || ""}`).includes(t))
    : null;
  const hit = byTitle || (titleOnly ? null : candidates[0]) || null;
  if (hit && used) used.add(mailId(hit));
  return hit;
}

// One waiter per run: it remembers which mails it already used, so two forms
// of the same company never get the same code.
function makeCodeWaiter({
  fetchMails,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 5 * 60 * 1000,
  pollMs = 10 * 1000,
}) {
  const used = new Set();
  const confirmUsed = new Set();
  return {
    // After a submit that showed no confirmation: look for the employer's
    // "thank you for applying" mail for up to `waitMs`.
    async confirmed({ company, title = "", since, waitMs = 60 * 1000 }) {
      const sinceMs = since instanceof Date ? since.getTime() : Number(since) || now();
      const started = now();
      for (;;) {
        let mails = [];
        try {
          mails = await fetchMails("confirmation");
        } catch {
          mails = [];
        }
        const hit = findConfirmation(mails, { company, title, sinceMs, used: confirmUsed });
        if (hit) return { subject: hit.subject, date: hit.date, from: hit.from };
        if (now() - started >= waitMs) return null;
        await sleep(pollMs);
      }
    },
    async wait({ company, since }) {
      const sinceMs = since instanceof Date ? since.getTime() : Number(since) || now();
      const started = now();
      for (;;) {
        let mails = [];
        try {
          mails = await fetchMails("code");
        } catch {
          mails = []; // a mailbox hiccup is retried on the next poll
        }
        const hit = pickCodeMail(mails, { company, sinceMs, used });
        if (hit) {
          used.add(hit.mail.rfcMessageId || hit.mail.messageId);
          return hit.code;
        }
        if (now() - started >= timeoutMs) return null;
        await sleep(pollMs);
      }
    },
  };
}

// IMAP fetcher over the apply mailbox (`<ID>_APPLY_GMAIL_*`, RFC 068 §5).
// Returns null when the mailbox is not configured — the caller then leaves
// the job to the human as before.
function imapCodeFetcher(profileId, env = process.env) {
  const imap = require("../tracking/gmail_imap.js");
  const creds = imap.loadApplyCredentials(profileId, { env });
  if (creds.source !== "env") return null;
  const QUERIES = {
    code: 'from:greenhouse-mail.io subject:"security code" newer_than:1d',
    confirmation: '-subject:"security code" newer_than:1d',
  };
  return async (kind = "code") =>
    imap.fetchEmailsForBatches(imap.makeGmailClient(creds), [QUERIES[kind] || QUERIES.code]);
}

module.exports = {
  parseSecurityCode,
  subjectCompany,
  companyMatches,
  pickCodeMail,
  findConfirmation,
  makeCodeWaiter,
  imapCodeFetcher,
};
