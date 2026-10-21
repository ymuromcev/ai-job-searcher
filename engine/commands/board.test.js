const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");

const applications = require("../core/applications_tsv.js");
const {
  makeBoardCommand,
  startBoardServer,
  makeDataLoaders,
  findRunning,
  lockPath,
  parsePort,
  SERVER_NAME,
} = require("./board.js");

function request(port, urlPath, { method = "GET", headers = {}, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: { Host: host || `127.0.0.1:${port}`, Connection: "close", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const FAKE_DATA = {
  registry: () => ({ profile: "demo", responses: [], todo: [], summary: { applied: 0 } }),
  week: () => ({ profile: "demo", tables: [] }),
  sources: () => ({ profile: "demo", sources: [], sites: [] }),
};

function capture() {
  const out = [];
  const err = [];
  return { stdout: (s) => out.push(s), stderr: (s) => err.push(s), out, err };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error("timed out waiting");
}

// --- server ----------------------------------------------------------------

test("server: refuses without the token, serves with it, checks Host and Origin", async () => {
  const { port, token, server, closed } = await startBoardServer({ data: FAKE_DATA });
  try {
    const noKey = await request(port, "/api/registry");
    assert.equal(noKey.status, 403);
    assert.equal(noKey.headers.server, SERVER_NAME);
    assert.match(noKey.body, /ключом/);

    const wrongKey = await request(port, "/api/registry?k=deadbeef");
    assert.equal(wrongKey.status, 403);

    const ok = await request(port, `/api/registry?k=${token}`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-type"], /application\/json/);
    assert.equal(JSON.parse(ok.body).profile, "demo");
    assert.match(ok.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(ok.headers["cache-control"], "no-store");

    const viaHeader = await request(port, "/api/week", { headers: { "X-Board-Token": token } });
    assert.equal(viaHeader.status, 200);

    const badHost = await request(port, `/api/registry?k=${token}`, { host: "evil.example:80" });
    assert.equal(badHost.status, 403);

    const localhostHost = await request(port, `/api/sources?k=${token}`, {
      host: `localhost:${port}`,
    });
    assert.equal(localhostHost.status, 200);

    const badOrigin = await request(port, `/api/registry?k=${token}`, {
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(badOrigin.status, 403);

    const goodOrigin = await request(port, `/api/registry?k=${token}`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(goodOrigin.status, 200);
  } finally {
    server.shutdown();
    await closed;
  }
});

test("server: page and assets; key injected into asset URLs; unknown paths 404; only GET/POST", async () => {
  const { port, token, server, closed } = await startBoardServer({ data: FAKE_DATA });
  try {
    const page = await request(port, `/?k=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.ok(page.body.includes(`app.js?k=${token}`));
    assert.ok(!page.body.includes("__KEY__"));
    for (const tab of [
      "Отклики",
      "Доделать руками",
      "Неделя",
      "Источники и сайты подачи",
      "Банк ответов",
    ]) {
      assert.ok(page.body.includes(tab), tab);
    }

    const js = await request(port, `/app.js?k=${token}`);
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /javascript/);
    assert.doesNotMatch(js.body, /innerHTML/); // untrusted text goes through textContent only

    const css = await request(port, `/style.css?k=${token}`);
    assert.equal(css.status, 200);

    assert.equal((await request(port, `/../board.js?k=${token}`)).status, 404);
    assert.equal((await request(port, `/index.html?k=${token}`)).status, 404);
    assert.equal((await request(port, `/api/nope?k=${token}`)).status, 404);
    assert.equal((await request(port, `/api/registry?k=${token}`, { method: "PUT" })).status, 405);
    assert.equal((await request(port, `/api/registry?k=${token}`, { method: "POST" })).status, 404);
  } finally {
    server.shutdown();
    await closed;
  }
});

test("server: a data loader that throws becomes a 500 JSON error", async () => {
  const data = {
    ...FAKE_DATA,
    registry: () => {
      throw new Error("applications.tsv header mismatch");
    },
  };
  const { port, token, server, closed } = await startBoardServer({ data });
  try {
    const res = await request(port, `/api/registry?k=${token}`);
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error, /header mismatch/);
  } finally {
    server.shutdown();
    await closed;
  }
});

test("server: POST /api/quit needs the token and stops the server", async () => {
  const { port, token, closed } = await startBoardServer({ data: FAKE_DATA });
  const refused = await request(port, "/api/quit", { method: "POST" });
  assert.equal(refused.status, 403);
  const res = await request(port, `/api/quit?k=${token}`, { method: "POST" });
  assert.equal(res.status, 200);
  await closed;
  await assert.rejects(request(port, `/api/registry?k=${token}`));
});

test("server: shuts itself down when idle", async () => {
  const { closed } = await startBoardServer({ data: FAKE_DATA, idleMs: 100 });
  const result = await Promise.race([closed.then(() => "closed"), sleep(3000).then(() => "open")]);
  assert.equal(result, "closed");
});

// --- command ---------------------------------------------------------------

function makeTempProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aijs-board-"));
  const profilesDir = path.join(root, "profiles");
  const profileDir = path.join(profilesDir, "demo");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "profile.json"),
    JSON.stringify({ id: "demo", modules: ["discovery:greenhouse"] })
  );
  applications.save(path.join(profileDir, "applications.tsv"), [
    {
      key: "greenhouse:1",
      source: "greenhouse",
      jobId: "1",
      companyName: "Acme <b>Corp</b>",
      title: "Senior PM",
      url: "https://boards.greenhouse.io/acme/jobs/1",
      locations: ["Remote"],
      status: "Applied",
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-12T00:00:00Z",
      fit_score: "Strong",
      applied_date: "2026-10-12",
    },
    {
      key: "greenhouse:2",
      source: "greenhouse",
      jobId: "2",
      companyName: "Beta",
      title: "PM",
      url: "https://boards.greenhouse.io/beta/jobs/2",
      locations: ["Remote"],
      status: "To Apply",
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-12T00:00:00Z",
    },
  ]);
  const stateDir = path.join(root, "state");
  return { root, profilesDir, profileDir, stateDir };
}

test("command: serves the temp profile, writes a 600 lock, a second launch reuses it, quit cleans up", async () => {
  const t = makeTempProfile();
  const opened = [];
  const cmd = makeBoardCommand({
    stateDir: () => t.stateDir,
    openUrl: (u) => opened.push(u),
    today: () => "2026-10-14",
    now: () => Date.parse("2026-10-14T12:00:00Z"),
    onSignal: () => () => {},
  });
  const io = capture();
  const ctx = {
    command: "board",
    profileId: "demo",
    flags: { noOpen: false, port: "" },
    env: {},
    profilesDir: t.profilesDir,
    stdout: io.stdout,
    stderr: io.stderr,
  };
  const running = cmd(ctx);
  const lockFile = lockPath(t.stateDir, "demo");
  await waitFor(() => fs.existsSync(lockFile));

  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.match(lock.token, /^[0-9a-f]{32}$/);
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], `http://127.0.0.1:${lock.port}/?k=${lock.token}`);

  const reg = JSON.parse((await request(lock.port, `/api/registry?k=${lock.token}`)).body);
  assert.equal(reg.profile, "demo");
  assert.equal(reg.responses.length, 1);
  assert.equal(reg.responses[0].company, "Acme <b>Corp</b>"); // raw text; the page uses textContent
  assert.equal(reg.summary.applied, 1);

  const week = JSON.parse((await request(lock.port, `/api/week?k=${lock.token}`)).body);
  assert.equal(week.report.refDate, "2026-10-14");
  assert.equal(week.report.week.applied, 1);
  assert.equal(week.tables[0].title, "Итоги");

  const src = JSON.parse((await request(lock.port, `/api/sources?k=${lock.token}`)).body);
  assert.deepEqual(
    src.sources.map((s) => [s.name, s.status_label]),
    [["Greenhouse", "Ещё не запускался"]]
  );
  assert.equal(src.sites[0].name, "Greenhouse");

  // The TSV is re-read on every request.
  const tsv = path.join(t.profileDir, "applications.tsv");
  const { apps } = applications.load(tsv);
  apps[1].status = "Applied";
  apps[1].applied_date = "2026-10-13";
  applications.save(tsv, apps);
  const reg2 = JSON.parse((await request(lock.port, `/api/registry?k=${lock.token}`)).body);
  assert.equal(reg2.responses.length, 2);

  // Second launch: reuses, does not start another server.
  const io2 = capture();
  const code2 = await cmd({ ...ctx, flags: { noOpen: true, port: "" }, stdout: io2.stdout });
  assert.equal(code2, 0);
  assert.match(io2.out.join("\n"), /already running/);
  assert.ok(io2.out.join("\n").includes(lock.token));
  assert.equal(opened.length, 1); // --no-open respected

  const quit = await request(lock.port, `/api/quit?k=${lock.token}`, { method: "POST" });
  assert.equal(quit.status, 200);
  assert.equal(await running, 0);
  assert.equal(fs.existsSync(lockFile), false);
  // Read-only: the board never touched the TSV it served.
  assert.equal(applications.load(tsv).apps.length, 2);
});

test("command: a stale lock (dead pid / nothing listening) is removed, not reused", async () => {
  const t = makeTempProfile();
  const lockFile = lockPath(t.stateDir, "demo");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, port: 1, token: "a".repeat(32) }));
  assert.equal(await findRunning(lockFile), null);
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, "not json");
  assert.equal(await findRunning(lockFile), null);
});

test("command: --port must be a valid port", async () => {
  const t = makeTempProfile();
  const io = capture();
  const cmd = makeBoardCommand({ stateDir: () => t.stateDir, openUrl: () => {} });
  const code = await cmd({
    command: "board",
    profileId: "demo",
    flags: { noOpen: true, port: "abc" },
    env: {},
    profilesDir: t.profilesDir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /--port must be an integer/);
});

test("parsePort", () => {
  assert.equal(parsePort(""), 0);
  assert.equal(parsePort(undefined), 0);
  assert.equal(parsePort("8080"), 8080);
  assert.ok(Number.isNaN(parsePort("70000")));
  assert.ok(Number.isNaN(parsePort("-1")));
  assert.ok(Number.isNaN(parsePort("12a")));
});

test("makeDataLoaders: v8 fields flow into the todo list and site health", () => {
  const rows = [
    {
      key: "a",
      companyName: "Acme",
      title: "PM",
      url: "https://jobs.lever.co/acme/1",
      status: "To Apply",
      apply_state: "failed",
      apply_note: "no_confirmation",
      updatedAt: "2026-10-14T00:00:00Z",
    },
  ];
  const t = makeTempProfile();
  const loaders = makeDataLoaders(
    { id: "demo", modules: [], paths: { root: t.profileDir, applicationsTsv: "x" } },
    {
      loadApplications: () => ({ apps: rows }),
      today: () => "2026-10-14",
      now: () => Date.parse("2026-10-14T12:00:00Z"),
    }
  );
  const reg = loaders.registry();
  assert.equal(reg.todo[0].reason, "после отправки нет подтверждения");
  const src = loaders.sources();
  const lever = src.sites.find((s) => s.name === "Lever");
  assert.equal(lever.status_label, "Не работает");
});

// --- «Банк ответов» (BL-225 U7) ---------------------------------------------

const BANK_A = "aaaaaaaa-0000-4000-8000-000000000001";
const BANK_B = "bbbbbbbb-0000-4000-8000-000000000002";

function postJson(port, urlPath, obj, headers = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  return request(port, urlPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...headers,
    },
    body,
  });
}

test("server: POST /api/rating — token, JSON only, strict body, size limit", async () => {
  const rated = [];
  const data = {
    ...FAKE_DATA,
    bank: ({ fresh }) => ({ profile: "demo", fresh, rows: [] }),
    rate: async (input) => {
      rated.push(input);
      return { ok: true, ...input };
    },
  };
  const { port, token, server, closed } = await startBoardServer({ data });
  try {
    const noKey = await postJson(port, "/api/rating", { id: BANK_A, rating: 5 });
    assert.equal(noKey.status, 403);

    const badOrigin = await postJson(
      port,
      "/api/rating",
      { id: BANK_A, rating: 5 },
      { "X-Board-Token": token, Origin: "http://evil.example" }
    );
    assert.equal(badOrigin.status, 403);

    const key = { "X-Board-Token": token };
    const ok = await postJson(port, "/api/rating", { id: BANK_A, rating: 5 }, key);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, id: BANK_A, rating: 5 });

    const clear = await postJson(port, "/api/rating", { id: BANK_A, rating: null }, key);
    assert.equal(clear.status, 200);

    const form = await request(port, "/api/rating", {
      method: "POST",
      headers: { ...key, "Content-Type": "application/x-www-form-urlencoded" },
      body: "id=x&rating=5",
    });
    assert.equal(form.status, 415);

    assert.equal((await postJson(port, "/api/rating", "{nope", key)).status, 400);
    for (const bad of [
      { id: BANK_A, rating: 9 },
      { id: BANK_A, rating: "5" },
      { id: "../../etc", rating: 3 },
      { id: BANK_A, rating: 3, admin: true },
      [BANK_A, 3],
    ]) {
      const res = await postJson(port, "/api/rating", bad, key);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.ok(JSON.parse(res.body).error);
    }
    const big = await postJson(
      port,
      "/api/rating",
      { id: BANK_A, rating: 3, pad: "x".repeat(5000) },
      key
    );
    assert.equal(big.status, 413);

    assert.deepEqual(rated, [
      { id: BANK_A, rating: 5 },
      { id: BANK_A, rating: null },
    ]);

    const bank = await request(port, `/api/bank?k=${token}&fresh=1`);
    assert.equal(bank.status, 200);
    assert.equal(JSON.parse(bank.body).fresh, true);
  } finally {
    server.shutdown();
    await closed;
  }
});

test("server: without bank loaders the bank endpoints are 404", async () => {
  const { port, token, server, closed } = await startBoardServer({ data: FAKE_DATA });
  try {
    assert.equal((await request(port, `/api/bank?k=${token}`)).status, 404);
    const res = await postJson(
      port,
      "/api/rating",
      { id: BANK_A, rating: 5 },
      { "X-Board-Token": token }
    );
    assert.equal(res.status, 404);
  } finally {
    server.shutdown();
    await closed;
  }
});

function bankLoaders(
  t,
  { fetch, clock = { now: Date.parse("2026-10-21T12:00:00Z") }, secrets } = {}
) {
  const calls = { fetch: 0 };
  const profile = {
    id: "demo",
    modules: [],
    notion: { application_qa_db_id: "qa-db" },
    paths: { root: t.profileDir, applicationsTsv: "x" },
  };
  const loaders = makeDataLoaders(
    profile,
    {
      loadApplications: () => ({ apps: [] }),
      loadSecrets: () => secrets || { NOTION_TOKEN: "t" },
      makeNotionClient: () => ({}),
      fetchAllAnswers: async () => {
        calls.fetch += 1;
        return fetch();
      },
      bankTtlMs: 60000,
      today: () => "2026-10-21",
      now: () => clock.now,
    },
    {}
  );
  return { loaders, calls, clock };
}

const NOTION_BANK = () => [
  {
    pageId: BANK_A,
    question: "Why us?",
    answer: "Old answer",
    company: "Acme",
    role: "PM",
    category: "Motivation",
    notes: "",
    createdAt: "2026-09-01T00:00:00.000Z",
  },
  {
    pageId: BANK_B,
    question: "Years of SQL?",
    answer: "Five",
    company: "Beta",
    role: "PM",
    category: "Experience",
    notes: "apply bot, truth-checked",
    createdAt: "2026-10-20T00:00:00.000Z",
  },
];

test("makeDataLoaders bank: newest first, cached, fresh refetches, ratings saved to the profile file", async () => {
  const t = makeTempProfile();
  const stateDir = path.join(t.profileDir, ".apply-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "apply_pre-2026-10-21.json"),
    JSON.stringify({ dry_run: false, bank_used: [{ key: "gh:1", bank_page_id: BANK_B }] })
  );
  const { loaders, calls, clock } = bankLoaders(t, { fetch: NOTION_BANK });

  const view = await loaders.bank();
  assert.equal(view.source, "notion");
  assert.equal(view.notice, "");
  assert.deepEqual(
    view.rows.map((r) => [r.id, r.origin, r.uses, r.rating]),
    [
      [BANK_B, "bot", 1, null],
      [BANK_A, "own", 0, null],
    ]
  );
  await loaders.bank();
  assert.equal(calls.fetch, 1, "second open within the TTL uses the cache");
  await loaders.bank({ fresh: true });
  assert.equal(calls.fetch, 2);
  clock.now += 61000;
  await loaders.bank();
  assert.equal(calls.fetch, 3, "the cache expires");

  assert.deepEqual(await loaders.rate({ id: BANK_B, rating: 2 }), {
    ok: true,
    id: BANK_B,
    rating: 2,
  });
  const file = path.join(t.profileDir, ".answers", "ratings.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.ratings[BANK_B].rating, 2);
  assert.equal(saved.ratings[BANK_B].question_key, "beta||pm||years of sql?");
  assert.equal(calls.fetch, 3, "rating a known answer needs no refetch");

  const after = await loaders.bank();
  assert.equal(after.rows[0].rating, 2);
  assert.equal(after.summary.rated, 1);

  await loaders.rate({ id: BANK_B, rating: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).ratings, {});

  await assert.rejects(
    loaders.rate({ id: "cccccccc-0000-4000-8000-000000000003", rating: 4 }),
    (err) => err.status === 404
  );
  assert.equal(calls.fetch, 4, "an unknown id refreshes the bank once before refusing");
});

test("makeDataLoaders bank: Notion down → local backup with a one-line notice; week shows the bank line", async () => {
  const t = makeTempProfile();
  const dir = path.join(t.profileDir, "application_answers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Acme_pm_20261020.md"),
    "# Acme — PM\n\n- **Date saved**: 2026-10-20T10:00:00.000Z\n- **Role**: PM\n- **Notes**: apply bot, truth-checked\n\n---\n\n## Q. Why us?\n\nBecause.\n"
  );
  const { loaders } = bankLoaders(t, {
    fetch: () => {
      throw new Error("ENOTFOUND api.notion.com");
    },
  });
  const view = await loaders.bank();
  assert.equal(view.source, "local");
  assert.match(
    view.notice,
    /^Notion недоступен \(ENOTFOUND api\.notion\.com\) — показан локальный бэкап \(1\)$/
  );
  assert.equal(view.rows[0].id, "local:Acme_pm_20261020.md#1");

  await loaders.rate({ id: "local:Acme_pm_20261020.md#1", rating: 5 });
  const week = await loaders.week();
  assert.deepEqual(week.report.bank.week, { added: 1, rated: 1, unrated: 0, average: 5 });
  const line = week.tables[0].rows.find((r) => /Ответы бота/.test(r[0]));
  assert.deepEqual(line.slice(1), [
    "1 (с оценкой 1, без оценки 0, средняя 5)",
    "1 (с оценкой 1, без оценки 0, средняя 5)",
  ]);
});

test("command: the bank tab reads the temp profile's local backup, and a rating is written there only", async () => {
  const t = makeTempProfile();
  const dir = path.join(t.profileDir, "application_answers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "Acme_pm_20261020.md"),
    "# Acme — PM\n\n- **Role**: PM\n\n---\n\n## Q. Why us?\n\nBecause.\n"
  );
  const cmd = makeBoardCommand({
    stateDir: () => t.stateDir,
    openUrl: () => {},
    today: () => "2026-10-21",
    now: () => Date.parse("2026-10-21T12:00:00Z"),
    onSignal: () => () => {},
    fetchAllAnswers: async () => {
      throw new Error("must not be called without a token");
    },
  });
  const io = capture();
  const running = cmd({
    command: "board",
    profileId: "demo",
    flags: { noOpen: true, port: "" },
    env: {},
    profilesDir: t.profilesDir,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  const lockFile = lockPath(t.stateDir, "demo");
  await waitFor(() => fs.existsSync(lockFile));
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  try {
    const bank = JSON.parse((await request(lock.port, `/api/bank?k=${lock.token}`)).body);
    assert.equal(bank.source, "local");
    assert.match(bank.notice, /Notion не настроен/);
    assert.equal(bank.rows.length, 1);
    const res = await postJson(
      lock.port,
      "/api/rating",
      { id: bank.rows[0].id, rating: 4 },
      { "X-Board-Token": lock.token }
    );
    assert.equal(res.status, 200);
    const saved = JSON.parse(
      fs.readFileSync(path.join(t.profileDir, ".answers", "ratings.json"), "utf8")
    );
    assert.equal(saved.ratings["local:Acme_pm_20261020.md#1"].rating, 4);
  } finally {
    await request(lock.port, `/api/quit?k=${lock.token}`, { method: "POST" });
    assert.equal(await running, 0);
  }
});
