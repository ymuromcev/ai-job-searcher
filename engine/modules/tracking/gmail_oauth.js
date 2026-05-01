// engine/modules/tracking/gmail_oauth.js
//
// Thin googleapis wrapper used by `check --auto` and `scripts/gmail_auth.js`.
// Pure w.r.t. profiles: takes credentials/refresh_token in, returns emails out.
//
// Output shape matches what the MCP two-phase flow writes to raw_emails.json:
//   { messageId, threadId, subject, from, body, snippet, date }
//
// Read-only: only `gmail.readonly` scope is ever requested.

const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// ---------- Credential loading ----------

function loadCredentials(profileId, opts = {}) {
  if (!profileId || typeof profileId !== "string") {
    throw new Error("loadCredentials: profileId required");
  }
  const env = opts.env || process.env;
  const upper = profileId.toUpperCase();
  const clientId = env[`${upper}_GMAIL_CLIENT_ID`] || null;
  const clientSecret = env[`${upper}_GMAIL_CLIENT_SECRET`] || null;
  let refreshToken = env[`${upper}_GMAIL_REFRESH_TOKEN`] || null;
  let source = refreshToken ? "env" : null;
  if (!refreshToken && opts.profileRoot) {
    const tokenFile = path.join(
      opts.profileRoot,
      ".gmail-tokens",
      "credentials.json"
    );
    if (fs.existsSync(tokenFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
        if (parsed && parsed.refresh_token) {
          refreshToken = parsed.refresh_token;
          source = "file";
        }
      } catch (err) {
        // Surface but don't crash — caller validates presence below.
        if (opts.onWarn) {
          opts.onWarn(`gmail_oauth: failed to parse ${tokenFile}: ${err.message}`);
        }
      }
    }
  }
  return { clientId, clientSecret, refreshToken, source };
}

function assertCredentials(creds, profileId) {
  const upper = String(profileId).toUpperCase();
  if (!creds.clientId) {
    throw new Error(
      `gmail_oauth: missing ${upper}_GMAIL_CLIENT_ID (set in .env or fly secrets)`
    );
  }
  if (!creds.clientSecret) {
    throw new Error(
      `gmail_oauth: missing ${upper}_GMAIL_CLIENT_SECRET (set in .env or fly secrets)`
    );
  }
  if (!creds.refreshToken) {
    throw new Error(
      `gmail_oauth: missing refresh_token. Run \`node scripts/gmail_auth.js --profile ${profileId}\` to obtain one.`
    );
  }
}

// ---------- OAuth + Gmail client ----------

function buildOAuthClient({ clientId, clientSecret, refreshToken }) {
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

function makeGmailClient(creds) {
  const auth = buildOAuthClient(creds);
  return google.gmail({ version: "v1", auth });
}

// ---------- Message decoding ----------

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return "";
  const lc = name.toLowerCase();
  const h = headers.find((x) => (x.name || "").toLowerCase() === lc);
  return h ? h.value || "" : "";
}

function decodeBase64Url(data) {
  if (!data) return "";
  // Gmail uses URL-safe base64 (- and _ instead of + and /). Buffer handles this
  // natively when given the "base64url" encoding in Node 16+, but we still need
  // to fall back gracefully.
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch (_e) {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").toString("utf8");
  }
}

function decodeBody(payload) {
  // DFS over MIME tree. Prefer text/plain, fall back to text/html.
  if (!payload) return "";
  let plain = null;
  let html = null;
  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || "";
    if (mime.startsWith("text/") && part.body && part.body.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (mime === "text/plain" && plain === null) plain = decoded;
      else if (mime === "text/html" && html === null) html = decoded;
    }
    if (Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return plain || html || "";
}

function messageToRaw(msg) {
  if (!msg || !msg.id) return null;
  const headers = (msg.payload && msg.payload.headers) || [];
  const subject = getHeader(headers, "Subject");
  const from = getHeader(headers, "From");
  const dateHeader = getHeader(headers, "Date");
  const body = decodeBody(msg.payload) || msg.snippet || "";
  const internalMs = Number(msg.internalDate || 0);
  return {
    messageId: msg.id,
    threadId: msg.threadId || null,
    subject: subject || "",
    from: from || "",
    body,
    snippet: msg.snippet || "",
    date: internalMs
      ? new Date(internalMs).toISOString()
      : dateHeader || null,
  };
}

// ---------- Search + fetch ----------

async function listMessageIds(gmail, query, opts = {}) {
  const out = [];
  let pageToken;
  const pageSize = opts.pageSize || 100;
  const maxPages = opts.maxPages || 10; // hard ceiling per batch
  let pages = 0;
  do {
    const resp = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: pageSize,
      pageToken,
    });
    const data = resp.data || resp || {};
    const messages = data.messages || [];
    for (const m of messages) out.push(m.id);
    pageToken = data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < maxPages);
  return out;
}

async function fetchMessage(gmail, id) {
  const resp = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  return resp.data || resp;
}

async function fetchEmailsForBatches(gmail, batches, opts = {}) {
  if (!gmail) throw new Error("fetchEmailsForBatches: gmail client required");
  if (!Array.isArray(batches)) {
    throw new Error("fetchEmailsForBatches: batches must be an array");
  }
  const seen = new Set();
  const out = [];
  const onProgress = opts.onProgress || (() => {});
  for (let i = 0; i < batches.length; i += 1) {
    const q = batches[i];
    onProgress({ phase: "list", batchIndex: i, total: batches.length, query: q });
    const ids = await listMessageIds(gmail, q, opts);
    onProgress({ phase: "ids", batchIndex: i, total: batches.length, count: ids.length });
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const full = await fetchMessage(gmail, id);
      const raw = messageToRaw(full);
      if (raw) out.push(raw);
    }
  }
  onProgress({ phase: "done", total: out.length });
  return out;
}

module.exports = {
  SCOPES,
  loadCredentials,
  assertCredentials,
  buildOAuthClient,
  makeGmailClient,
  getHeader,
  decodeBase64Url,
  decodeBody,
  messageToRaw,
  listMessageIds,
  fetchMessage,
  fetchEmailsForBatches,
};
