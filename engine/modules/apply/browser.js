// Playwright Chromium launcher for the apply command (RFC 068 §2).
//
// Uses `playwright-core` with Playwright's own Chromium build
// (~/Library/Caches/ms-playwright, installed by `npx playwright install
// chromium`). Never the system Google Chrome — the candidate's personal
// browser profile must not be touched: `launchOptions` never sets `channel`
// or `executablePath`, so even a headed window is Playwright's Chromium.
//
// Window mode per ATS (RFC 069 §2): Ashby forms open in a *visible* window
// (its invisible bot check rejects the headless browser); Greenhouse and
// Lever stay headless. `headlessFor(ats, overrides)` is the single switch;
// the apply command takes it as an injectable dep.

const fs = require("fs");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch {
    return null;
  }
}

// { ok: true, executablePath } | { ok: false, reason }
function browserStatus() {
  const pw = loadPlaywright();
  if (!pw) return { ok: false, reason: "playwright-core is not installed (npm ci)" };
  let exe = "";
  try {
    exe = pw.chromium.executablePath();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!exe || !fs.existsSync(exe)) {
    return {
      ok: false,
      reason: `Playwright Chromium not found at ${exe || "<unknown>"} — run: npx playwright install chromium`,
    };
  }
  return { ok: true, executablePath: exe };
}

const HEADLESS_BY_ATS = Object.freeze({ greenhouse: true, lever: true, ashby: false });

// true → headless, false → visible window. Unknown ATS / no ATS (aggregator
// pages read while resolving a link) → headless.
function headlessFor(ats, overrides = null) {
  const table = overrides ? { ...HEADLESS_BY_ATS, ...overrides } : HEADLESS_BY_ATS;
  const v = ats ? table[ats] : undefined;
  return v === undefined ? true : Boolean(v);
}

// Options for chromium.launch — Playwright's own Chromium only.
function launchOptions({ headless = true } = {}) {
  return { headless: Boolean(headless) };
}

async function launchBrowser({ headless = true } = {}) {
  const status = browserStatus();
  if (!status.ok) throw new Error(status.reason);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(launchOptions({ headless }));
  return {
    browser,
    // Fresh context per job: no cookie bleed between applications.
    async newPage() {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        // A visible window (apply --phase open) follows the window size.
        viewport: headless ? { width: 1280, height: 1600 } : null,
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
      });
      const page = await context.newPage();
      return {
        page,
        close: () => context.close().catch(() => {}),
      };
    },
    close: () => browser.close().catch(() => {}),
  };
}

module.exports = {
  launchBrowser,
  launchOptions,
  headlessFor,
  HEADLESS_BY_ATS,
  browserStatus,
  USER_AGENT,
};
