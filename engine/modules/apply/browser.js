// Playwright Chromium launcher for the apply command (RFC 068 §2).
//
// Uses `playwright-core` with Playwright's own Chromium build
// (~/Library/Caches/ms-playwright, installed by `npx playwright install
// chromium`). Never the system Google Chrome — the candidate's personal
// browser profile must not be touched.

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

async function launchBrowser({ headless = true } = {}) {
  const status = browserStatus();
  if (!status.ok) throw new Error(status.reason);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless });
  return {
    browser,
    // Fresh context per job: no cookie bleed between applications.
    async newPage() {
      const context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 1600 },
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

module.exports = { launchBrowser, browserStatus, USER_AGENT };
