// engine/modules/tracking/gmail_imap.js
//
// Thin imapflow wrapper used by `check --auto` and `scripts/dump_emails.js`.
// Drop-in replacement for the previous OAuth-based `gmail_oauth.js` — keeps
// the same public surface so `check.js` doesn't change shape.
//
// Why IMAP + app password instead of OAuth: Google's Testing-mode OAuth
// refresh-tokens expire after 7 days. App passwords (with 2FA) don't expire.
// See `rfc/021-gmail-cron-imap.md` for the full rationale.
//
// Output shape matches what the MCP two-phase flow writes to raw_emails.json:
//   { messageId, threadId, subject, from, body, snippet, date }
//
// Read-only: connects to `[Gmail]/All Mail`, never STOREs, never EXPUNGEs.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const IMAP_HOST = "imap.gmail.com";
const IMAP_PORT = 993;
// Gmail names the "All Mail" folder per UI locale: "[Gmail]/All Mail" in
// English, "[Gmail]/Вся почта" in Russian, "[Gmail]/Все письма" in
// some accounts, etc. Resolve it via the SPECIAL-USE \All flag (RFC 6154)
// instead of hard-coding a name. Fallback to INBOX if the server doesn't
// advertise \All (vanishingly unlikely for Gmail, but defensible).
const ALL_MAIL_FALLBACK = "INBOX";

// ---------- Credential loading ----------

function loadCredentials(profileId, opts = {}) {
  if (!profileId || typeof profileId !== "string") {
    throw new Error("loadCredentials: profileId required");
  }
  const env = opts.env || process.env;
  const upper = profileId.toUpperCase();
  const user = env[`${upper}_GMAIL_USER`] || null;
  const appPassword = env[`${upper}_GMAIL_APP_PASSWORD`] || null;
  return {
    user,
    appPassword,
    source: user && appPassword ? "env" : null,
  };
}

function assertCredentials(creds, profileId) {
  const upper = String(profileId).toUpperCase();
  if (!creds.user) {
    throw new Error(`gmail_imap: missing ${upper}_GMAIL_USER (set in .env or fly secrets)`);
  }
  if (!creds.appPassword) {
    throw new Error(
      `gmail_imap: missing ${upper}_GMAIL_APP_PASSWORD. Generate one at ` +
        `https://myaccount.google.com/apppasswords (requires 2FA).`
    );
  }
}

// ---------- IMAP client ----------

function makeGmailClient(creds, opts = {}) {
  // Caller owns the lifecycle — fetchEmailsForBatches() connects + logs out.
  // Logger off by default: imapflow's default logger spams stdout with
  // per-command timing that drowns the cron's JSON output.
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: creds.user,
      pass: creds.appPassword,
    },
    logger: opts.logger || false,
    // 60s for slow fly cold-starts; one batch takes ~3-5s on warm machine.
    socketTimeout: opts.socketTimeout || 60_000,
    greetingTimeout: opts.greetingTimeout || 30_000,
  });
}

// ---------- Gmail message-id format conversion ----------
//
// Gmail REST API returns Message.id as a hex string (e.g. "18ad08abc1234").
// IMAP's X-GM-MSGID is the SAME 64-bit number but imapflow surfaces it as a
// decimal string (e.g. "1729543812804660" — see imapflow/lib/tools.js:419).
// We persist the hex form in processed_messages.json to stay compatible with
// historic entries created via the Gmail REST API path.
//
// BigInt is required: X-GM-MSGID can exceed Number.MAX_SAFE_INTEGER (2^53-1).

function gmailIdToHex(decimalStr) {
  if (decimalStr === null || decimalStr === undefined || decimalStr === "") {
    return "";
  }
  try {
    return BigInt(String(decimalStr)).toString(16);
  } catch (_err) {
    // Not a valid integer — return as-is, caller decides what to do.
    return String(decimalStr);
  }
}

function hexToGmailId(hexStr) {
  if (hexStr === null || hexStr === undefined || hexStr === "") return "";
  try {
    return BigInt("0x" + String(hexStr)).toString(10);
  } catch (_err) {
    return String(hexStr);
  }
}

// ---------- Message decoding ----------

function formatFromAddress(envelope) {
  // Match the format Gmail API returns for the `From` header:
  //   `"Display Name" <addr@example.com>` or just `addr@example.com`.
  if (!envelope || !Array.isArray(envelope.from) || envelope.from.length === 0) {
    return "";
  }
  const a = envelope.from[0];
  const address = a && a.address ? a.address : "";
  const name = a && a.name ? a.name : "";
  if (name && address) return `"${name}" <${address}>`;
  return address || name || "";
}

async function messageToRaw(msg, opts = {}) {
  // `msg` is an imapflow FetchMessageObject. We want the same output shape
  // as the old gmail_oauth.messageToRaw(): {messageId, threadId, subject,
  // from, body, snippet, date}.
  if (!msg) return null;
  const messageId = gmailIdToHex(msg.emailId || "");
  if (!messageId) return null;

  const envelope = msg.envelope || {};
  const subject = envelope.subject || "";
  const from = formatFromAddress(envelope);
  const date =
    msg.internalDate instanceof Date
      ? msg.internalDate.toISOString()
      : envelope.date instanceof Date
        ? envelope.date.toISOString()
        : null;

  let body = "";
  if (msg.source) {
    const parser = opts.parseMessage || simpleParser;
    try {
      const parsed = await parser(msg.source);
      // Match gmail_oauth.decodeBody preference: text/plain → text/html.
      body = parsed.text || (parsed.html ? stripHtmlTags(parsed.html) : "") || "";
    } catch (_err) {
      body = "";
    }
  }

  // Gmail API exposes a server-rendered snippet (~200 chars, HTML-stripped).
  // IMAP doesn't — synthesize from body. Used only for human-readable logs.
  const snippet = body.slice(0, 200).replace(/\s+/g, " ").trim();

  return {
    messageId,
    threadId: gmailIdToHex(msg.threadId || "") || null,
    subject,
    from,
    body,
    snippet,
    date,
  };
}

function stripHtmlTags(html) {
  if (!html) return "";
  // Minimal fallback for when mailparser couldn't produce plain text.
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- All Mail mailbox resolution ----------

async function resolveAllMailMailbox(client) {
  // Prefer SPECIAL-USE \All (RFC 6154) — language-agnostic.
  const list = await client.list();
  if (!Array.isArray(list)) return ALL_MAIL_FALLBACK;
  const bySpecial = list.find((b) => b && (b.specialUse === "\\All" || b.specialUse === "All"));
  if (bySpecial && bySpecial.path) return bySpecial.path;
  // Best-effort name fallback across known locales.
  const byName = list.find(
    (b) =>
      b &&
      b.path &&
      /\bAll Mail\b|Вся почта|Все письма|Всі листи|Tüm Postalar|Tutta la posta|Toda la correspondencia|Toute la correspondance|Όλα τα μηνύματα/i.test(
        b.path
      )
  );
  if (byName && byName.path) return byName.path;
  return ALL_MAIL_FALLBACK;
}

// ---------- Search + fetch ----------

async function listUidsForQuery(client, gmailQuery, opts = {}) {
  // imapflow accepts `gmailRaw: <query>` to use Gmail's X-GM-RAW extension —
  // same search syntax as Gmail's web UI (`from:`, `subject:`, `after:`, etc).
  // See imapflow/lib/search-compiler.js:249-262 (GMRAW / GMAILRAW case).
  if (!gmailQuery) return [];
  const maxResults = opts.maxResults || 1000;
  const uids = await client.search({ gmailRaw: gmailQuery }, { uid: true });
  if (!Array.isArray(uids)) return [];
  // Hard ceiling per batch — same intent as the old pageSize*maxPages cap.
  return uids.slice(0, maxResults);
}

async function fetchEmailsForBatches(client, batches, opts = {}) {
  if (!client) throw new Error("fetchEmailsForBatches: client required");
  if (!Array.isArray(batches)) {
    throw new Error("fetchEmailsForBatches: batches must be an array");
  }
  const onProgress = opts.onProgress || (() => {});
  const parseMessage = opts.parseMessage || simpleParser;
  const seen = new Set();
  const out = [];

  await client.connect();
  let lock;
  try {
    const mailboxPath = await resolveAllMailMailbox(client);
    lock = await client.getMailboxLock(mailboxPath);
    for (let i = 0; i < batches.length; i += 1) {
      const q = batches[i];
      onProgress({ phase: "list", batchIndex: i, total: batches.length, query: q });
      const uids = await listUidsForQuery(client, q, opts);
      onProgress({
        phase: "ids",
        batchIndex: i,
        total: batches.length,
        count: uids.length,
      });
      if (uids.length === 0) continue;

      // Fetch one-by-one. Gmail's IMAP rejects very large UID-set fetches with
      // BAD if the line exceeds ~8KB; per-message fetches stay well below
      // any limit and let us bail out on individual parse errors.
      for (const uid of uids) {
        const msg = await client.fetchOne(
          uid,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            source: true,
            emailId: true,
            threadId: true,
          },
          { uid: true }
        );
        if (!msg) continue;
        const idHex = gmailIdToHex(msg.emailId || "");
        if (!idHex || seen.has(idHex)) continue;
        seen.add(idHex);
        const raw = await messageToRaw(msg, { parseMessage });
        if (raw) out.push(raw);
      }
    }
  } finally {
    if (lock && typeof lock.release === "function") {
      try {
        lock.release();
      } catch (_e) {
        // best-effort
      }
    }
    try {
      await client.logout();
    } catch (_e) {
      // best-effort
    }
  }
  onProgress({ phase: "done", total: out.length });
  return out;
}

// ---------- Single-message fetch by Gmail message-id (used by dump_emails) ----------

async function fetchMessageByGmailId(client, gmailMessageIdHex, opts = {}) {
  // Translates Gmail REST API hex id → decimal → IMAP UID via X-GM-MSGID,
  // then fetches the full message. Used by scripts/dump_emails.js.
  const decimal = hexToGmailId(gmailMessageIdHex);
  if (!decimal) return null;
  await client.connect();
  let lock;
  try {
    const mailboxPath = await resolveAllMailMailbox(client);
    lock = await client.getMailboxLock(mailboxPath);
    const uids = await client.search({ emailId: decimal }, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) return null;
    const uid = uids[0];
    const msg = await client.fetchOne(
      uid,
      {
        uid: true,
        envelope: true,
        internalDate: true,
        source: true,
        emailId: true,
        threadId: true,
      },
      { uid: true }
    );
    if (!msg) return null;
    return messageToRaw(msg, opts);
  } finally {
    if (lock && typeof lock.release === "function") {
      try {
        lock.release();
      } catch (_e) {
        // best-effort
      }
    }
    try {
      await client.logout();
    } catch (_e) {
      // best-effort
    }
  }
}

module.exports = {
  IMAP_HOST,
  IMAP_PORT,
  ALL_MAIL_FALLBACK,
  resolveAllMailMailbox,
  loadCredentials,
  assertCredentials,
  makeGmailClient,
  gmailIdToHex,
  hexToGmailId,
  formatFromAddress,
  stripHtmlTags,
  messageToRaw,
  listUidsForQuery,
  fetchEmailsForBatches,
  fetchMessageByGmailId,
};
