// `board` command (RFC 068 §8): a local registry page.
//
//   node engine/cli.js board --profile <id> [--no-open] [--port N]
//
// Mechanism ported from piggy-bank's board (rfc/008-board.md there):
//   - node:http server bound to 127.0.0.1 only;
//   - a random token in the URL (`?k=`), also accepted as X-Board-Token;
//   - Host / Origin checks against the exact loopback host:port (DNS
//     rebinding), and a loopback check on the peer address;
//   - a lock file (port / pid / token, mode 600) outside the profile folder,
//     so a second launch reuses the running server instead of starting another;
//   - idle shutdown after 30 minutes, POST /api/quit to close it from the page.
//
// Every data endpoint re-reads applications.tsv (and the scan health log /
// the nightly run log) per request. The answer bank («Банк ответов», BL-225
// U7) comes from Notion — or the local backup — through a short in-memory
// cache. The one thing the board writes is the owner's answer ratings
// (POST /api/rating → profiles/<id>/.answers/ratings.json); the TSV and
// Notion are never written. Other people's text (company names, titles,
// reasons, answers) leaves as JSON and the page renders it with textContent
// only.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFile } = require("child_process");

const profileLoader = require("../core/profile_loader.js");
const applications = require("../core/applications_tsv.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { buildRegistryView } = require("../core/registry_view.js");
const { buildWeeklyReport, weeklyTables } = require("../core/weekly_report.js");
const { buildSourceHealth } = require("../core/source_health.js");
const scanHealthLog = require("../core/scan_health_log.js");
const nightRunsLog = require("../core/night_runs_log.js");
const { todayLocalISO } = require("../core/auto_dead_sweep.js");
const { makeClient } = require("../core/notion_sync.js");
const { fetchAllAnswers } = require("../core/qa_notion.js");
const answerBank = require("../core/answer_bank.js");
const bankStore = require("../core/answer_bank_store.js");

const HOST = "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SERVER_NAME = "ai-job-searcher-board";
const LOCK_FILE = "board.lock";
const IDLE_MS = 30 * 60 * 1000;
const UI_DIR = path.join(__dirname, "..", "ui", "board");
const PAGE = "index.html";
const ASSETS = {
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
};
const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; " +
  "img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NO_KEY = "нужна ссылка с ключом: открой реестр командой board";
const MAX_BODY = 2048; // POST /api/rating carries { id, rating } only
const BANK_TTL_MS = 60 * 1000;

// --- state dir / lock ------------------------------------------------------

// Runtime state stays on this machine (never in the profile folder, which
// may be synced): ~/Library/Application Support/ai-job-searcher/state.
function defaultStateDir(env = process.env) {
  const fromEnv = env && env.AI_JOB_SEARCHER_STATE_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  return path.join(os.homedir(), "Library", "Application Support", "ai-job-searcher", "state");
}

function lockPath(stateDir, profileId) {
  return path.join(stateDir, profileId, LOCK_FILE);
}

function writeLock(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readLock(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function removeLockIfOurs(file, pid = process.pid) {
  const data = readLock(file);
  if (data && data.pid === pid) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the number now belongs to someone else's process.
    return false;
  }
}

// Is our board still answering on that port? Asked WITHOUT the token: only
// our server refuses with 403 and our Server header, so a recycled pid or a
// foreign program on the port never gets handed the key.
function probeBoard(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port,
        path: "/api/registry",
        method: "GET",
        headers: { Host: `${HOST}:${port}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 403 && res.headers.server === SERVER_NAME);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function findRunning(file) {
  const data = readLock(file);
  if (!data) return null;
  const { port, token, pid } = data;
  const valid =
    Number.isInteger(port) &&
    port > 0 &&
    typeof token === "string" &&
    /^[0-9a-f]{32,}$/.test(token);
  if (valid && pidAlive(pid) && (await probeBoard(port))) return { port, token, pid };
  try {
    fs.unlinkSync(file);
  } catch {
    // Stale lock already removed.
  }
  return null;
}

function boardUrl(port, token) {
  return `http://${HOST}:${port}/?k=${token}`;
}

// --- server ----------------------------------------------------------------

function tokenMatches(given, token) {
  const a = crypto
    .createHash("sha256")
    .update(String(given || ""), "utf8")
    .digest();
  const b = crypto.createHash("sha256").update(String(token), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function readAsset(name) {
  return fs.readFileSync(path.join(UI_DIR, name));
}

// `data` = { registry(), week(), sources(), bank?({ fresh }), rate?({ id, rating }) }
// → plain JSON objects or promises of them. Injected so tests can run the
// server against a temp TSV.
function createBoardServer({ data, token, idleMs = IDLE_MS, clock = () => Date.now() }) {
  if (!data) throw new Error("createBoardServer: data loaders are required");
  const state = {
    token: token || crypto.randomBytes(16).toString("hex"),
    hosts: new Set(),
    origins: new Set(),
    touched: clock(),
    port: 0,
  };

  function send(res, code, body, type, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    res.writeHead(code, {
      Server: SERVER_NAME,
      "Content-Type": type,
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
      ...extra,
    });
    res.end(buf);
  }
  const text = (res, code, msg, extra) => send(res, code, msg, "text/plain; charset=utf-8", extra);
  const json = (res, code, obj) =>
    send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");

  // Run a data loader (sync or async) and answer with its JSON; an error is a
  // JSON 500 (or the error's own `status`).
  function respond(res, fn) {
    let out;
    try {
      out = fn();
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
    return Promise.resolve(out).then(
      (value) => json(res, 200, value),
      (err) => json(res, err.status || 500, { error: err.message })
    );
  }

  // POST /api/rating — body exactly { id, rating }, JSON, at most MAX_BODY.
  function handleRating(req, res) {
    const type = String(req.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type !== "application/json") {
      req.resume();
      return json(res, 415, { error: "нужен JSON" });
    }
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) {
      req.resume();
      return json(res, 413, { error: "слишком большой запрос" });
    }
    return readBody(req, MAX_BODY).then(
      (buf) => {
        let body;
        try {
          body = JSON.parse(buf.toString("utf8"));
        } catch {
          return json(res, 400, { error: "тело запроса — не JSON" });
        }
        const v = answerBank.validateRatingInput(body);
        if (!v.ok) return json(res, 400, { error: v.error });
        return respond(res, () => data.rate({ id: v.id, rating: v.rating }));
      },
      (err) => json(res, err.status || 400, { error: err.message })
    );
  }

  function allowed(req, url) {
    if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
    if (!state.hosts.has(String(req.headers.host || "").trim())) return false;
    const origin = req.headers.origin;
    if (origin && !state.origins.has(origin)) return false;
    const given = url.searchParams.get("k") || req.headers["x-board-token"] || "";
    return tokenMatches(given, state.token);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      req.resume();
      return text(res, 400, "bad request", { Connection: "close" });
    }
    if (!allowed(req, url)) {
      req.resume();
      return text(res, 403, NO_KEY, req.method === "GET" ? {} : { Connection: "close" });
    }
    state.touched = clock();

    if (req.method === "POST") {
      if (url.pathname === "/api/rating" && typeof data.rate === "function") {
        return handleRating(req, res);
      }
      req.resume(); // the other endpoints read no body
      if (url.pathname === "/api/quit") {
        json(res, 200, { ok: true });
        setImmediate(() => server.shutdown());
        return undefined;
      }
      return text(res, 404, "нет такой страницы", { Connection: "close" });
    }
    if (req.method !== "GET") {
      req.resume();
      return text(res, 405, "только чтение", { Allow: "GET, POST", Connection: "close" });
    }

    const p = url.pathname;
    try {
      if (p === "/") {
        // The token goes into the asset URLs so css/js pass the same check.
        const page = readAsset(PAGE).toString("utf8").split("__KEY__").join(state.token);
        return send(res, 200, page, "text/html; charset=utf-8");
      }
      const name = p.slice(1);
      if (Object.prototype.hasOwnProperty.call(ASSETS, name)) {
        return send(res, 200, readAsset(name), ASSETS[name]);
      }
      if (p === "/api/registry") return respond(res, () => data.registry());
      if (p === "/api/week") return respond(res, () => data.week());
      if (p === "/api/sources") return respond(res, () => data.sources());
      if (p === "/api/bank" && typeof data.bank === "function") {
        const fresh = url.searchParams.get("fresh") === "1";
        return respond(res, () => data.bank({ fresh }));
      }
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
    return text(res, 404, "нет такой страницы");
  });

  let watchdog = null;
  let closing = false;
  server.shutdown = () => {
    if (closing) return;
    closing = true;
    if (watchdog) clearInterval(watchdog);
    server.close();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  };

  server.on("listening", () => {
    state.port = server.address().port;
    state.hosts = new Set([`${HOST}:${state.port}`, `localhost:${state.port}`]);
    state.origins = new Set([...state.hosts].map((h) => `http://${h}`));
    const step = Math.max(50, Math.min(5000, Math.floor(idleMs / 4)));
    watchdog = setInterval(() => {
      if (clock() - state.touched > idleMs) server.shutdown();
    }, step);
    watchdog.unref();
  });

  server.boardState = state;
  return server;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        const err = new Error("слишком большой запрос");
        err.status = 413;
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// Listen on 127.0.0.1:<port> (0 = any free port). Resolves once listening.
function startBoardServer({ data, port = 0, token, idleMs, clock } = {}) {
  const server = createBoardServer({ data, token, idleMs, clock });
  const closed = new Promise((resolve) => server.once("close", resolve));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.removeListener("error", reject);
      const { port: actual } = server.address();
      const tok = server.boardState.token;
      resolve({ server, port: actual, token: tok, url: boardUrl(actual, tok), closed });
    });
  });
}

// --- data ------------------------------------------------------------------

// The answer bank, fetched at most once per `bankTtlMs` (Notion is slow; the
// tab should open fast). Concurrent callers share one fetch; `fresh` skips
// the cache (the «Обновить» button). → { entries, source, notice, uses }
function makeBankLoader(profile, deps, env) {
  const ttl = Number.isFinite(deps.bankTtlMs) ? deps.bankTtlMs : BANK_TTL_MS;
  let cache = null;
  let inflight = null;
  async function load() {
    const secrets = (deps.loadSecrets && deps.loadSecrets(profile.id, env)) || {};
    const bank = await bankStore.loadAnswerBank({
      profile,
      secrets,
      deps: { makeClient: deps.makeNotionClient, fetchAllAnswers: deps.fetchAllAnswers },
    });
    const preRecords = bankStore.readPreRecords(path.join(profile.paths.root, ".apply-state"));
    return { ...bank, uses: answerBank.countBankUses(preRecords) };
  }
  return function getBank({ fresh = false } = {}) {
    if (!fresh && cache && deps.now() - cache.at < ttl) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = load()
      .then((value) => {
        cache = { at: deps.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

function makeDataLoaders(profile, deps, env = {}) {
  const tsvPath = profile.paths.applicationsTsv;
  const readRows = () => deps.loadApplications(tsvPath).apps;
  const ratingsFile = bankStore.ratingsPath(profile.paths.root);
  const getBank = makeBankLoader(profile, deps, env);
  return {
    registry: () => ({
      profile: profile.id,
      generatedAt: new Date(deps.now()).toISOString(),
      ...buildRegistryView(readRows()),
    }),
    week: async () => {
      const rows = readRows();
      const nights = nightRunsLog.readNightRuns(nightRunsLog.nightRunsPath(profile.paths.root));
      let bank;
      try {
        const b = await getBank();
        bank = { entries: b.entries, ratings: bankStore.readRatings(ratingsFile) };
      } catch {
        bank = undefined; // the bank line is optional; the rest of the week still shows
      }
      const report = buildWeeklyReport(rows, deps.today(), { nights, bank });
      return { profile: profile.id, report, tables: weeklyTables(report) };
    },
    bank: async ({ fresh = false } = {}) => {
      const b = await getBank({ fresh });
      const ratings = bankStore.readRatings(ratingsFile);
      return {
        profile: profile.id,
        source: b.source,
        notice: b.notice,
        ...answerBank.buildBankView(b.entries, ratings, { uses: b.uses }),
      };
    },
    // Only ids present in the bank can be rated; an unknown id refreshes the
    // bank once (a new answer may have been pushed since the last fetch).
    rate: async ({ id, rating }) => {
      const find = (b) => b.entries.find((e) => e.pageId === id);
      let entry = find(await getBank());
      if (!entry) entry = find(await getBank({ fresh: true }));
      if (!entry) {
        const err = new Error("нет такого ответа в банке");
        err.status = 404;
        throw err;
      }
      const now = new Date(deps.now());
      const next = answerBank.setRating(bankStore.readRatings(ratingsFile), {
        id,
        rating,
        questionKey: answerBank.questionKey(entry),
        now,
      });
      bankStore.writeRatings(ratingsFile, next, { now });
      return { ok: true, id, rating };
    },
    sources: () => ({
      profile: profile.id,
      ...buildSourceHealth({
        runs: scanHealthLog.readScanRuns(scanHealthLog.scanRunsPath(profile.paths.root)),
        modules: profile.modules,
        rows: readRows(),
        now: new Date(deps.now()),
      }),
    }),
  };
}

// --- command ---------------------------------------------------------------

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!cmd) return;
  // Fixed argv, no shell; the URL is built here from a number and hex token.
  execFile(cmd, [url], () => {});
}

function parsePort(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return n >= 0 && n <= 65535 ? n : NaN;
}

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadApplications: applications.load,
  loadSecrets: profileLoader.loadSecrets,
  makeNotionClient: makeClient,
  fetchAllAnswers,
  bankTtlMs: BANK_TTL_MS,
  openUrl: openInBrowser,
  now: () => Date.now(),
  today: () => todayLocalISO(),
  stateDir: (env) => defaultStateDir(env),
  idleMs: IDLE_MS,
  onSignal: (handler) => {
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    return () => {
      process.removeListener("SIGINT", handler);
      process.removeListener("SIGTERM", handler);
    };
  },
};

function makeBoardCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function boardCommand(ctx) {
    const { profileId, flags = {}, stdout, stderr } = ctx;
    const env = ctx.env || process.env;
    const port = parsePort(flags.port);
    if (Number.isNaN(port)) {
      stderr(`error: --port must be an integer 0..65535, got "${flags.port}"`);
      return 1;
    }
    const profilesDir = resolveProfilesDir(ctx, env);
    const profile = deps.loadProfile(profileId, { profilesDir, warn: () => {} });
    const lockFile = lockPath(deps.stateDir(env), profile.id);

    const live = await findRunning(lockFile);
    if (live) {
      const url = boardUrl(live.port, live.token);
      stdout(`board already running for ${profile.id}: ${url}`);
      if (!flags.noOpen) deps.openUrl(url);
      return 0;
    }

    let started;
    try {
      started = await startBoardServer({
        data: makeDataLoaders(profile, deps, env),
        port,
        idleMs: deps.idleMs,
      });
    } catch (err) {
      stderr(`error: cannot listen on ${HOST}:${port}: ${err.code || err.message}`);
      return 1;
    }
    writeLock(lockFile, {
      pid: process.pid,
      port: started.port,
      token: started.token,
      profile: profile.id,
      started_at: new Date(deps.now()).toISOString(),
    });
    const offSignal = deps.onSignal(() => started.server.shutdown());
    stdout(`board for ${profile.id}: ${started.url}`);
    stdout("writes only answer ratings; closes after 30 min idle or from the page");
    if (!flags.noOpen) deps.openUrl(started.url);

    await started.closed;
    offSignal();
    removeLockIfOurs(lockFile);
    stdout("board closed");
    return 0;
  };
}

module.exports = makeBoardCommand();
module.exports.makeBoardCommand = makeBoardCommand;
module.exports.createBoardServer = createBoardServer;
module.exports.startBoardServer = startBoardServer;
module.exports.makeDataLoaders = makeDataLoaders;
module.exports.findRunning = findRunning;
module.exports.lockPath = lockPath;
module.exports.defaultStateDir = defaultStateDir;
module.exports.parsePort = parsePort;
module.exports.SERVER_NAME = SERVER_NAME;
