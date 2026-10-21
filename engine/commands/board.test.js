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

function request(port, urlPath, { method = "GET", headers = {}, host } = {}) {
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
    req.end();
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
    for (const tab of ["Отклики", "Доделать руками", "Неделя", "Источники и сайты подачи"]) {
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
