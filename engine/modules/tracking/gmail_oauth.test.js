// Tests for engine/modules/tracking/gmail_oauth.js
//
// Covers: credential loading from env / file, message decoding, multi-page
// search + dedup, error surfacing.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const oauth = require("./gmail_oauth.js");

function makeTmpProfileRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-oauth-test-"));
  fs.mkdirSync(path.join(root, ".gmail-tokens"), { recursive: true });
  return root;
}

// ---------- loadCredentials ----------

test("loadCredentials: env wins when both env + file present", () => {
  const root = makeTmpProfileRoot();
  fs.writeFileSync(
    path.join(root, ".gmail-tokens", "credentials.json"),
    JSON.stringify({ refresh_token: "from-file" })
  );
  const env = {
    JARED_GMAIL_CLIENT_ID: "cid",
    JARED_GMAIL_CLIENT_SECRET: "csec",
    JARED_GMAIL_REFRESH_TOKEN: "from-env",
  };
  const creds = oauth.loadCredentials("jared", { env, profileRoot: root });
  assert.equal(creds.clientId, "cid");
  assert.equal(creds.clientSecret, "csec");
  assert.equal(creds.refreshToken, "from-env");
  assert.equal(creds.source, "env");
});

test("loadCredentials: falls back to file when env token absent", () => {
  const root = makeTmpProfileRoot();
  fs.writeFileSync(
    path.join(root, ".gmail-tokens", "credentials.json"),
    JSON.stringify({ refresh_token: "from-file" })
  );
  const creds = oauth.loadCredentials("jared", {
    env: { JARED_GMAIL_CLIENT_ID: "cid", JARED_GMAIL_CLIENT_SECRET: "csec" },
    profileRoot: root,
  });
  assert.equal(creds.refreshToken, "from-file");
  assert.equal(creds.source, "file");
});

test("loadCredentials: returns null token when neither present (no throw)", () => {
  const root = makeTmpProfileRoot();
  const creds = oauth.loadCredentials("jared", {
    env: {},
    profileRoot: root,
  });
  assert.equal(creds.refreshToken, null);
  assert.equal(creds.clientId, null);
  assert.equal(creds.source, null);
});

test("loadCredentials: malformed token file warns but does not throw", () => {
  const root = makeTmpProfileRoot();
  fs.writeFileSync(
    path.join(root, ".gmail-tokens", "credentials.json"),
    "not json{"
  );
  const warnings = [];
  const creds = oauth.loadCredentials("jared", {
    env: { JARED_GMAIL_CLIENT_ID: "cid", JARED_GMAIL_CLIENT_SECRET: "csec" },
    profileRoot: root,
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(creds.refreshToken, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to parse/);
});

test("loadCredentials: profileId is uppercased for env lookup", () => {
  const env = {
    LILIA_GMAIL_CLIENT_ID: "li_cid",
    LILIA_GMAIL_CLIENT_SECRET: "li_csec",
    LILIA_GMAIL_REFRESH_TOKEN: "li_rt",
  };
  const creds = oauth.loadCredentials("lilia", { env });
  assert.equal(creds.clientId, "li_cid");
  assert.equal(creds.refreshToken, "li_rt");
});

test("loadCredentials: throws on missing/invalid profileId", () => {
  assert.throws(() => oauth.loadCredentials("", { env: {} }), /profileId/);
  assert.throws(() => oauth.loadCredentials(null, { env: {} }), /profileId/);
});

// ---------- assertCredentials ----------

test("assertCredentials: passes when all three set", () => {
  oauth.assertCredentials(
    { clientId: "a", clientSecret: "b", refreshToken: "c" },
    "jared"
  );
});

test("assertCredentials: throws actionable message on missing refresh_token", () => {
  assert.throws(
    () =>
      oauth.assertCredentials(
        { clientId: "a", clientSecret: "b", refreshToken: null },
        "jared"
      ),
    /scripts\/gmail_auth\.js --profile jared/
  );
});

test("assertCredentials: throws on missing client_id with profile-prefixed env name", () => {
  assert.throws(
    () =>
      oauth.assertCredentials(
        { clientId: null, clientSecret: "b", refreshToken: "c" },
        "lilia"
      ),
    /LILIA_GMAIL_CLIENT_ID/
  );
});

// ---------- decodeBase64Url + decodeBody ----------

test("decodeBase64Url: handles URL-safe base64 (-, _ chars)", () => {
  // "Hello World!?" → standard b64: "SGVsbG8gV29ybGQhPw==" ; URL-safe: same
  // (no - or _ in this short string), so synthesize one with -/_.
  // "<<>>" (4 bytes) → base64 "PDw+Pg==" (no padding mods needed) → URL-safe "PDw-Pg"
  const decoded = oauth.decodeBase64Url("PDw-Pg");
  assert.equal(decoded, "<<>>");
});

test("decodeBase64Url: empty string → empty", () => {
  assert.equal(oauth.decodeBase64Url(""), "");
  assert.equal(oauth.decodeBase64Url(null), "");
});

test("decodeBody: prefers text/plain over text/html", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>html body</p>").toString("base64url") },
      },
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("plain body").toString("base64url") },
      },
    ],
  };
  assert.equal(oauth.decodeBody(payload), "plain body");
});

test("decodeBody: falls back to text/html when no text/plain", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: Buffer.from("<h1>just html</h1>").toString("base64url") },
  };
  assert.equal(oauth.decodeBody(payload), "<h1>just html</h1>");
});

test("decodeBody: walks nested multipart trees", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: Buffer.from("nested plain").toString("base64url") },
          },
        ],
      },
    ],
  };
  assert.equal(oauth.decodeBody(payload), "nested plain");
});

test("decodeBody: empty payload → empty string", () => {
  assert.equal(oauth.decodeBody(null), "");
  assert.equal(oauth.decodeBody({}), "");
});

// ---------- messageToRaw ----------

test("messageToRaw: extracts subject/from/body, computes ISO date from internalDate", () => {
  const msg = {
    id: "abc123",
    threadId: "thr1",
    internalDate: "1730000000000", // 2024-10-27T03:33:20Z
    snippet: "snip text",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: "Hello" },
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "Date", value: "Sun, 27 Oct 2024 03:33:20 GMT" },
      ],
      body: { data: Buffer.from("body content").toString("base64url") },
    },
  };
  const raw = oauth.messageToRaw(msg);
  assert.equal(raw.messageId, "abc123");
  assert.equal(raw.threadId, "thr1");
  assert.equal(raw.subject, "Hello");
  assert.equal(raw.from, "Alice <alice@example.com>");
  assert.equal(raw.body, "body content");
  assert.equal(raw.snippet, "snip text");
  assert.equal(raw.date, "2024-10-27T03:33:20.000Z");
});

test("messageToRaw: falls back to snippet when body is empty", () => {
  const msg = {
    id: "x",
    snippet: "snippet only",
    payload: { headers: [{ name: "Subject", value: "S" }] },
  };
  const raw = oauth.messageToRaw(msg);
  assert.equal(raw.body, "snippet only");
  assert.equal(raw.subject, "S");
});

test("messageToRaw: returns null on missing id", () => {
  assert.equal(oauth.messageToRaw(null), null);
  assert.equal(oauth.messageToRaw({}), null);
});

// ---------- listMessageIds ----------

test("listMessageIds: paginates while nextPageToken present", async () => {
  const calls = [];
  const fakeGmail = {
    users: {
      messages: {
        list: async (params) => {
          calls.push(params);
          if (!params.pageToken) {
            return { data: { messages: [{ id: "1" }, { id: "2" }], nextPageToken: "p2" } };
          }
          if (params.pageToken === "p2") {
            return { data: { messages: [{ id: "3" }], nextPageToken: null } };
          }
          throw new Error("unexpected page token");
        },
      },
    },
  };
  const ids = await oauth.listMessageIds(fakeGmail, "from:foo");
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].q, "from:foo");
});

test("listMessageIds: handles empty result", async () => {
  const fakeGmail = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [] } }),
      },
    },
  };
  const ids = await oauth.listMessageIds(fakeGmail, "from:bar");
  assert.deepEqual(ids, []);
});

test("listMessageIds: respects maxPages cap", async () => {
  let pages = 0;
  const fakeGmail = {
    users: {
      messages: {
        list: async () => {
          pages += 1;
          return { data: { messages: [{ id: `id-${pages}` }], nextPageToken: "next" } };
        },
      },
    },
  };
  const ids = await oauth.listMessageIds(fakeGmail, "q", { maxPages: 3 });
  assert.equal(ids.length, 3);
  assert.equal(pages, 3);
});

// ---------- fetchEmailsForBatches ----------

test("fetchEmailsForBatches: dedupes ids across batches", async () => {
  const fakeGmail = {
    users: {
      messages: {
        list: async (params) => {
          if (params.q === "q1") return { data: { messages: [{ id: "a" }, { id: "b" }] } };
          if (params.q === "q2") return { data: { messages: [{ id: "b" }, { id: "c" }] } };
          return { data: { messages: [] } };
        },
        get: async ({ id }) => ({
          data: {
            id,
            internalDate: "1700000000000",
            snippet: `snip-${id}`,
            payload: { headers: [{ name: "Subject", value: `subj-${id}` }] },
          },
        }),
      },
    },
  };
  const out = await oauth.fetchEmailsForBatches(fakeGmail, ["q1", "q2"]);
  const ids = out.map((e) => e.messageId).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("fetchEmailsForBatches: emits progress events", async () => {
  const events = [];
  const fakeGmail = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [{ id: "x" }] } }),
        get: async () => ({ data: { id: "x", payload: { headers: [] } } }),
      },
    },
  };
  await oauth.fetchEmailsForBatches(fakeGmail, ["q1", "q2"], {
    onProgress: (e) => events.push(e),
  });
  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes("list"));
  assert.ok(phases.includes("ids"));
  assert.equal(phases[phases.length - 1], "done");
});

test("fetchEmailsForBatches: throws on missing gmail client", async () => {
  await assert.rejects(
    () => oauth.fetchEmailsForBatches(null, ["q"]),
    /gmail client required/
  );
});

test("fetchEmailsForBatches: throws on non-array batches", async () => {
  await assert.rejects(
    () => oauth.fetchEmailsForBatches({}, "not-array"),
    /batches must be an array/
  );
});

test("fetchEmailsForBatches: surfaces gmail.users.messages.get errors", async () => {
  const fakeGmail = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [{ id: "boom" }] } }),
        get: async () => {
          throw new Error("gmail 500");
        },
      },
    },
  };
  await assert.rejects(
    () => oauth.fetchEmailsForBatches(fakeGmail, ["q"]),
    /gmail 500/
  );
});

// ---------- buildOAuthClient + makeGmailClient ----------

test("buildOAuthClient: returns OAuth2 instance with credentials set", () => {
  const client = oauth.buildOAuthClient({
    clientId: "cid",
    clientSecret: "csec",
    refreshToken: "rt",
  });
  // googleapis stores credentials internally; check that setCredentials was called
  // by reading the field via the documented `credentials` getter.
  assert.equal(client.credentials.refresh_token, "rt");
});

test("makeGmailClient: returns gmail client object exposing users.messages", () => {
  const gmail = oauth.makeGmailClient({
    clientId: "cid",
    clientSecret: "csec",
    refreshToken: "rt",
  });
  assert.ok(gmail);
  assert.ok(gmail.users);
  assert.ok(gmail.users.messages);
  assert.equal(typeof gmail.users.messages.list, "function");
});
