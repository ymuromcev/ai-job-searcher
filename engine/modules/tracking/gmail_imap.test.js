// Tests for engine/modules/tracking/gmail_imap.js
//
// Covers: credential loading by profile id, Gmail-id format conversion
// (decimal ↔ hex compatibility with existing processed_messages.json),
// envelope-to-raw mapping, multi-batch fetch with dedup, IMAP lifecycle
// (connect / lock / logout even on error).
//
// No network: imapflow client is fully mocked via DI.

const test = require("node:test");
const assert = require("node:assert/strict");

const imap = require("./gmail_imap.js");

// ---------- loadCredentials ----------

test("loadCredentials: reads <UPPER>_GMAIL_USER + _APP_PASSWORD from env", () => {
  const env = {
    JARED_GMAIL_USER: "jared@example.com",
    JARED_GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
  };
  const creds = imap.loadCredentials("jared", { env });
  assert.equal(creds.user, "jared@example.com");
  assert.equal(creds.appPassword, "abcd efgh ijkl mnop");
  assert.equal(creds.source, "env");
});

test("loadCredentials: namespaces by profile id (jared vs lilia don't collide)", () => {
  const env = {
    JARED_GMAIL_USER: "jared@example.com",
    JARED_GMAIL_APP_PASSWORD: "jared-pass",
    LILIA_GMAIL_USER: "lilia@example.com",
    LILIA_GMAIL_APP_PASSWORD: "lilia-pass",
  };
  const j = imap.loadCredentials("jared", { env });
  const l = imap.loadCredentials("lilia", { env });
  assert.equal(j.user, "jared@example.com");
  assert.equal(j.appPassword, "jared-pass");
  assert.equal(l.user, "lilia@example.com");
  assert.equal(l.appPassword, "lilia-pass");
});

test("loadCredentials: returns nulls when env missing (no throw)", () => {
  const creds = imap.loadCredentials("jared", { env: {} });
  assert.equal(creds.user, null);
  assert.equal(creds.appPassword, null);
  assert.equal(creds.source, null);
});

test("loadCredentials: throws when profileId not a string", () => {
  assert.throws(() => imap.loadCredentials(null, { env: {} }), /profileId/);
  assert.throws(() => imap.loadCredentials("", { env: {} }), /profileId/);
});

// ---------- assertCredentials ----------

test("assertCredentials: actionable error message points at app-passwords page", () => {
  assert.throws(
    () => imap.assertCredentials({ user: "jared@example.com", appPassword: null }, "jared"),
    /JARED_GMAIL_APP_PASSWORD.*myaccount\.google\.com\/apppasswords/s
  );
});

test("assertCredentials: complains about missing user", () => {
  assert.throws(
    () => imap.assertCredentials({ user: null, appPassword: "x" }, "jared"),
    /JARED_GMAIL_USER/
  );
});

test("assertCredentials: passes when both fields present", () => {
  assert.doesNotThrow(() =>
    imap.assertCredentials({ user: "jared@example.com", appPassword: "xxxx" }, "jared")
  );
});

// ---------- gmailIdToHex / hexToGmailId ----------
//
// Critical for processed_messages.json compatibility with historical
// entries created via the Gmail REST API path.

test("gmailIdToHex: converts large decimal to lowercase hex", () => {
  // 1729543812804660 decimal = 6256dde1234 hex... let's pick known pairs.
  // BigInt("1729543812804660").toString(16) = "624a8d3b4a4234"... computed at runtime.
  // Instead, assert the round-trip property on known production-shape ids.
  assert.equal(imap.gmailIdToHex("0"), "0");
  assert.equal(imap.gmailIdToHex("255"), "ff");
  assert.equal(imap.gmailIdToHex("1729543812804660"), BigInt("1729543812804660").toString(16));
});

test("hexToGmailId: converts hex back to decimal string", () => {
  assert.equal(imap.hexToGmailId("ff"), "255");
  assert.equal(imap.hexToGmailId("0"), "0");
  // Production-shape Gmail API id (13-hex chars)
  const hex = "18ad08abc1234";
  assert.equal(imap.hexToGmailId(hex), BigInt("0x" + hex).toString(10));
});

test("gmailIdToHex/hexToGmailId: round-trip preserves 64-bit ids", () => {
  // Gmail X-GM-MSGID can exceed Number.MAX_SAFE_INTEGER. Round-trip must
  // not lose precision — BigInt is mandatory.
  const big = "1729543812804660"; // > 2^50, well above MAX_SAFE_INTEGER's range of risk
  const hex = imap.gmailIdToHex(big);
  assert.equal(imap.hexToGmailId(hex), big);

  // Another sample, deliberately past MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991)
  const huge = "18014398509481984"; // 2^54
  assert.equal(imap.hexToGmailId(imap.gmailIdToHex(huge)), huge);
});

test("gmailIdToHex: empty / null / invalid input → safe defaults", () => {
  assert.equal(imap.gmailIdToHex(""), "");
  assert.equal(imap.gmailIdToHex(null), "");
  assert.equal(imap.gmailIdToHex(undefined), "");
  assert.equal(imap.gmailIdToHex("not-a-number"), "not-a-number");
});

test("hexToGmailId: empty / null / invalid input → safe defaults", () => {
  assert.equal(imap.hexToGmailId(""), "");
  assert.equal(imap.hexToGmailId(null), "");
  assert.equal(imap.hexToGmailId(undefined), "");
  assert.equal(imap.hexToGmailId("not-hex-zzz"), "not-hex-zzz");
});

// ---------- formatFromAddress ----------

test("formatFromAddress: name + address → quoted-name format", () => {
  assert.equal(
    imap.formatFromAddress({
      from: [{ name: "Recruiter Bob", address: "bob@acme.io" }],
    }),
    '"Recruiter Bob" <bob@acme.io>'
  );
});

test("formatFromAddress: address only → bare address", () => {
  assert.equal(
    imap.formatFromAddress({ from: [{ address: "noreply@figma.com" }] }),
    "noreply@figma.com"
  );
});

test("formatFromAddress: empty envelope → empty string (no crash)", () => {
  assert.equal(imap.formatFromAddress({}), "");
  assert.equal(imap.formatFromAddress({ from: [] }), "");
  assert.equal(imap.formatFromAddress(null), "");
});

// ---------- stripHtmlTags ----------

test("stripHtmlTags: removes tags and script/style, collapses whitespace", () => {
  const html = "<style>.x{}</style><p>Hello   <b>world</b></p><script>x</script>";
  assert.equal(imap.stripHtmlTags(html), "Hello world");
});

test("stripHtmlTags: decodes &nbsp; to space", () => {
  assert.equal(imap.stripHtmlTags("a&nbsp;&nbsp;b"), "a b");
});

// ---------- messageToRaw ----------

test("messageToRaw: maps imapflow FetchMessageObject → output shape", async () => {
  const fakeParse = async () => ({ text: "Body line 1\nBody line 2", html: "" });
  const msg = {
    uid: 42,
    emailId: "1729543812804660", // decimal X-GM-MSGID
    threadId: "1729543000000000",
    envelope: {
      subject: "Application received",
      from: [{ name: "Greenhouse", address: "no-reply@greenhouse.io" }],
      date: new Date("2026-05-08T15:00:00Z"),
    },
    internalDate: new Date("2026-05-08T15:00:01Z"),
    source: Buffer.from("raw mime here"),
  };
  const raw = await imap.messageToRaw(msg, { parseMessage: fakeParse });
  assert.equal(raw.messageId, BigInt("1729543812804660").toString(16));
  assert.equal(raw.threadId, BigInt("1729543000000000").toString(16));
  assert.equal(raw.subject, "Application received");
  assert.equal(raw.from, '"Greenhouse" <no-reply@greenhouse.io>');
  assert.equal(raw.body, "Body line 1\nBody line 2");
  assert.equal(raw.date, "2026-05-08T15:00:01.000Z");
  assert.equal(raw.snippet, "Body line 1 Body line 2"); // whitespace-collapsed
});

test("messageToRaw: missing emailId → null (skipped by caller)", async () => {
  const raw = await imap.messageToRaw({ emailId: "" });
  assert.equal(raw, null);
});

test("messageToRaw: html-only body falls back to stripped html", async () => {
  const fakeParse = async () => ({ text: "", html: "<p>Hello <b>world</b></p>" });
  const msg = {
    emailId: "255",
    envelope: { subject: "x", from: [{ address: "a@b" }] },
    internalDate: new Date("2026-05-08T00:00:00Z"),
    source: Buffer.from("x"),
  };
  const raw = await imap.messageToRaw(msg, { parseMessage: fakeParse });
  assert.equal(raw.body, "Hello world");
});

test("messageToRaw: parseMessage throw → body stays empty, no crash", async () => {
  const fakeParse = async () => {
    throw new Error("parse failed");
  };
  const msg = {
    emailId: "255",
    envelope: { subject: "x", from: [] },
    internalDate: new Date(),
    source: Buffer.from("x"),
  };
  const raw = await imap.messageToRaw(msg, { parseMessage: fakeParse });
  assert.equal(raw.body, "");
  assert.equal(raw.snippet, "");
});

// ---------- fetchEmailsForBatches ----------
//
// Mock imapflow client surface: { connect, getMailboxLock, search, fetchOne,
// logout }. Verifies: dedup across batches, lifecycle (logout in finally
// even on error), progress callback shape.

function makeMockClient({
  searchByQuery = {},
  fetchByUid = {},
  throwOnFetch = null,
  list = [{ path: "[Gmail]/All Mail", specialUse: "\\All" }],
} = {}) {
  const calls = {
    connect: 0,
    logout: 0,
    lockReleased: 0,
    search: [],
    fetchOne: [],
    listed: 0,
  };
  const client = {
    async connect() {
      calls.connect += 1;
    },
    async list() {
      calls.listed += 1;
      return list;
    },
    async getMailboxLock(mailbox) {
      calls.mailbox = mailbox;
      return {
        release() {
          calls.lockReleased += 1;
        },
      };
    },
    async search(criteria, _opts) {
      calls.search.push(criteria);
      const q = criteria.gmailRaw || criteria.emailId;
      return searchByQuery[q] || [];
    },
    async fetchOne(uid, _query, _opts) {
      calls.fetchOne.push(uid);
      if (throwOnFetch && throwOnFetch === uid) {
        throw new Error("simulated fetch failure");
      }
      return fetchByUid[uid] || null;
    },
    async logout() {
      calls.logout += 1;
    },
  };
  return { client, calls };
}

test("fetchEmailsForBatches: connects, locks All Mail, logs out", async () => {
  const { client, calls } = makeMockClient();
  await imap.fetchEmailsForBatches(client, []);
  assert.equal(calls.connect, 1);
  assert.equal(calls.mailbox, "[Gmail]/All Mail");
  assert.equal(calls.logout, 1);
});

test("resolveAllMailMailbox: prefers SPECIAL-USE \\All flag (locale-agnostic)", async () => {
  // Russian-locale Gmail: All Mail named "Вся почта" — SPECIAL-USE still set.
  const { client } = makeMockClient({
    list: [
      { path: "INBOX", specialUse: null },
      { path: "[Gmail]/Вся почта", specialUse: "\\All" },
      { path: "[Gmail]/Корзина", specialUse: "\\Trash" },
    ],
  });
  const path = await imap.resolveAllMailMailbox(client);
  assert.equal(path, "[Gmail]/Вся почта");
});

test("resolveAllMailMailbox: name-based fallback when no SPECIAL-USE", async () => {
  const { client } = makeMockClient({
    list: [
      { path: "INBOX", specialUse: null },
      { path: "[Gmail]/All Mail", specialUse: null },
    ],
  });
  const path = await imap.resolveAllMailMailbox(client);
  assert.equal(path, "[Gmail]/All Mail");
});

test("resolveAllMailMailbox: INBOX fallback when nothing matches", async () => {
  const { client } = makeMockClient({ list: [{ path: "INBOX" }] });
  const path = await imap.resolveAllMailMailbox(client);
  assert.equal(path, "INBOX");
});

test("fetchEmailsForBatches: dedups same emailId across batches", async () => {
  const fakeParse = async () => ({ text: "body", html: "" });
  const msgA = {
    uid: 1,
    emailId: "100",
    threadId: "200",
    envelope: { subject: "A", from: [{ address: "x@y" }] },
    internalDate: new Date("2026-05-01T00:00:00Z"),
    source: Buffer.from("a"),
  };
  const { client } = makeMockClient({
    // Both batches return UID 1 (same Gmail message id)
    searchByQuery: {
      "from:foo": [1],
      "subject:bar": [1],
    },
    fetchByUid: { 1: msgA },
  });
  const out = await imap.fetchEmailsForBatches(client, ["from:foo", "subject:bar"], {
    parseMessage: fakeParse,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].messageId, BigInt("100").toString(16));
});

test("fetchEmailsForBatches: progress callback fires for each phase", async () => {
  const { client } = makeMockClient({
    searchByQuery: { "from:foo": [] },
  });
  const phases = [];
  await imap.fetchEmailsForBatches(client, ["from:foo"], {
    onProgress: (e) => phases.push(e.phase),
  });
  assert.deepEqual(phases, ["list", "ids", "done"]);
});

test("fetchEmailsForBatches: logout still runs if a fetch throws", async () => {
  const { client, calls } = makeMockClient({
    searchByQuery: { "from:foo": [1] },
    throwOnFetch: 1,
  });
  await assert.rejects(
    () => imap.fetchEmailsForBatches(client, ["from:foo"]),
    /simulated fetch failure/
  );
  assert.equal(calls.logout, 1, "logout must run in finally");
  assert.equal(calls.lockReleased, 1, "lock must release in finally");
});

test("fetchEmailsForBatches: empty batch list → no work but lifecycle ok", async () => {
  const { client, calls } = makeMockClient();
  const out = await imap.fetchEmailsForBatches(client, []);
  assert.deepEqual(out, []);
  assert.equal(calls.connect, 1);
  assert.equal(calls.logout, 1);
  assert.equal(calls.search.length, 0);
});

test("fetchEmailsForBatches: hex messageId matches what gmail_oauth path produced", async () => {
  // Regression check: existing processed_messages.json entries were saved
  // as hex strings (Gmail REST API format). New IMAP path must emit the
  // exact same hex for the same underlying Gmail message id.
  const fakeParse = async () => ({ text: "x", html: "" });
  const decimal = "1729543812804660";
  const expectedHex = BigInt(decimal).toString(16);
  const msg = {
    uid: 7,
    emailId: decimal,
    threadId: "1",
    envelope: { subject: "x", from: [{ address: "a@b" }] },
    internalDate: new Date(),
    source: Buffer.from("x"),
  };
  const { client } = makeMockClient({
    searchByQuery: { q: [7] },
    fetchByUid: { 7: msg },
  });
  const out = await imap.fetchEmailsForBatches(client, ["q"], {
    parseMessage: fakeParse,
  });
  assert.equal(out[0].messageId, expectedHex);
});

// ---------- fetchMessageByGmailId ----------

test("fetchMessageByGmailId: hex id → decimal search → fetch by uid", async () => {
  const fakeParse = async () => ({ text: "hello", html: "" });
  const hex = "18ad08abc1234";
  const expectedDecimal = BigInt("0x" + hex).toString(10);
  const msg = {
    uid: 99,
    emailId: expectedDecimal,
    threadId: "1",
    envelope: { subject: "S", from: [{ address: "a@b" }] },
    internalDate: new Date("2026-05-08T00:00:00Z"),
    source: Buffer.from("x"),
  };
  const { client, calls } = makeMockClient({
    searchByQuery: { [expectedDecimal]: [99] },
    fetchByUid: { 99: msg },
  });
  const raw = await imap.fetchMessageByGmailId(client, hex, {
    parseMessage: fakeParse,
  });
  assert.equal(raw.messageId, hex);
  assert.equal(raw.subject, "S");
  // Search must be called with the decimal form, not hex
  assert.deepEqual(calls.search[0], { emailId: expectedDecimal });
});

test("fetchMessageByGmailId: not found → null, lifecycle preserved", async () => {
  const { client, calls } = makeMockClient({ searchByQuery: {} });
  const raw = await imap.fetchMessageByGmailId(client, "abc");
  assert.equal(raw, null);
  assert.equal(calls.connect, 1);
  assert.equal(calls.logout, 1);
});

// ---------- fetchMessagesByGmailIds (batch) ----------

test("fetchMessagesByGmailIds: one connect + one logout for N ids", async () => {
  const fakeParse = async () => ({ text: "body", html: "" });
  const decA = BigInt("0xaaaa").toString(10);
  const decB = BigInt("0xbbbb").toString(10);
  const msgA = {
    uid: 1,
    emailId: decA,
    threadId: "1",
    envelope: { subject: "A", from: [{ address: "a@b" }] },
    internalDate: new Date("2026-05-01T00:00:00Z"),
    source: Buffer.from("x"),
  };
  const msgB = {
    uid: 2,
    emailId: decB,
    threadId: "1",
    envelope: { subject: "B", from: [{ address: "b@c" }] },
    internalDate: new Date("2026-05-02T00:00:00Z"),
    source: Buffer.from("y"),
  };
  const { client, calls } = makeMockClient({
    searchByQuery: { [decA]: [1], [decB]: [2] },
    fetchByUid: { 1: msgA, 2: msgB },
  });
  const out = await imap.fetchMessagesByGmailIds(client, ["aaaa", "bbbb"], {
    parseMessage: fakeParse,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "aaaa");
  assert.equal(out[0].raw.subject, "A");
  assert.equal(out[1].id, "bbbb");
  assert.equal(out[1].raw.subject, "B");
  // Critical: connection / logout / lock-release run exactly once for the batch.
  assert.equal(calls.connect, 1, "single connect");
  assert.equal(calls.logout, 1, "single logout");
  assert.equal(calls.lockReleased, 1, "single lock release");
});

test("fetchMessagesByGmailIds: per-id 'not found' returns raw=null without error", async () => {
  const fakeParse = async () => ({ text: "body", html: "" });
  const decA = BigInt("0xaaaa").toString(10);
  const msgA = {
    uid: 1,
    emailId: decA,
    threadId: "1",
    envelope: { subject: "A", from: [{ address: "a@b" }] },
    internalDate: new Date("2026-05-01T00:00:00Z"),
    source: Buffer.from("x"),
  };
  const { client } = makeMockClient({
    searchByQuery: { [decA]: [1] }, // "bbbb" has no mapping → empty search
    fetchByUid: { 1: msgA },
  });
  const out = await imap.fetchMessagesByGmailIds(client, ["aaaa", "bbbb"], {
    parseMessage: fakeParse,
  });
  assert.equal(out[0].raw.subject, "A");
  assert.equal(out[1].raw, null);
  assert.equal(out[1].error, undefined); // 'not found' is silent — caller decides
});

test("fetchMessagesByGmailIds: per-id throw captured as {error}, batch continues", async () => {
  const fakeParse = async () => ({ text: "body", html: "" });
  const decA = BigInt("0xaaaa").toString(10);
  const decB = BigInt("0xbbbb").toString(10);
  const msgB = {
    uid: 2,
    emailId: decB,
    threadId: "1",
    envelope: { subject: "B", from: [{ address: "b@c" }] },
    internalDate: new Date("2026-05-02T00:00:00Z"),
    source: Buffer.from("y"),
  };
  // throwOnFetch fires on uid 1 → first id errors, second succeeds.
  const { client, calls } = makeMockClient({
    searchByQuery: { [decA]: [1], [decB]: [2] },
    fetchByUid: { 2: msgB },
    throwOnFetch: 1,
  });
  const out = await imap.fetchMessagesByGmailIds(client, ["aaaa", "bbbb"], {
    parseMessage: fakeParse,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].raw, null);
  assert.match(out[0].error, /simulated fetch failure/);
  assert.equal(out[1].raw.subject, "B", "batch continues past per-id failure");
  assert.equal(calls.logout, 1, "logout still runs");
});

test("fetchMessagesByGmailIds: progress callback fires per id with ok/error", async () => {
  const fakeParse = async () => ({ text: "body", html: "" });
  const decA = BigInt("0xaaaa").toString(10);
  const msgA = {
    uid: 1,
    emailId: decA,
    threadId: "1",
    envelope: { subject: "A", from: [{ address: "a@b" }] },
    internalDate: new Date("2026-05-01T00:00:00Z"),
    source: Buffer.from("x"),
  };
  const events = [];
  const { client } = makeMockClient({
    searchByQuery: { [decA]: [1] },
    fetchByUid: { 1: msgA },
  });
  await imap.fetchMessagesByGmailIds(client, ["aaaa", "bbbb"], {
    parseMessage: fakeParse,
    onProgress: (e) => events.push({ index: e.index, ok: e.ok, error: e.error }),
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].ok, true);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].error, "not found");
});

test("fetchMessagesByGmailIds: invalid hex id → {error: 'invalid id'}", async () => {
  const { client } = makeMockClient();
  const out = await imap.fetchMessagesByGmailIds(client, [""]);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw, null);
  assert.equal(out[0].error, "invalid id");
});

test("fetchMessagesByGmailIds: empty input → no work, lifecycle still runs", async () => {
  const { client, calls } = makeMockClient();
  const out = await imap.fetchMessagesByGmailIds(client, []);
  assert.deepEqual(out, []);
  assert.equal(calls.connect, 1);
  assert.equal(calls.logout, 1);
});
