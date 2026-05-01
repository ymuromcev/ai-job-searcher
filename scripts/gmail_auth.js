#!/usr/bin/env node
// One-time Gmail OAuth consent flow (per profile).
//
//   node scripts/gmail_auth.js --profile <id>
//
// Opens your browser to Google's consent screen, captures the auth code on
// localhost:3000, exchanges it for a refresh_token, and writes the token to
//   profiles/<id>/.gmail-tokens/credentials.json (mode 600, gitignored).
//
// Required env (root .env):
//   {ID}_GMAIL_CLIENT_ID       — OAuth Client ID (Desktop type)
//   {ID}_GMAIL_CLIENT_SECRET   — OAuth Client Secret
//
// IMPORTANT: This script never transmits credentials anywhere except Google.
// The refresh_token only ever lives on your local disk (and later, if you
// choose, in `fly secrets set` — that step is printed at the end).

require("dotenv").config();
const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { google } = require("googleapis");

const { SCOPES } = require("../engine/modules/tracking/gmail_oauth.js");

const PORT = Number(process.env.GMAIL_AUTH_PORT || 3000);
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile" && argv[i + 1]) {
      args.profile = argv[i + 1];
      i += 1;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "usage: node scripts/gmail_auth.js --profile <id>",
      "",
      "Required env (root .env):",
      "  {ID}_GMAIL_CLIENT_ID",
      "  {ID}_GMAIL_CLIENT_SECRET",
      "",
      "After consent, refresh_token is saved to:",
      "  profiles/<id>/.gmail-tokens/credentials.json",
    ].join("\n")
  );
}

function openBrowser(target) {
  const cmd =
    process.platform === "darwin"
      ? `open "${target}"`
      : process.platform === "win32"
        ? `start "" "${target}"`
        : `xdg-open "${target}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn(`(could not auto-open browser: ${err.message})`);
    }
  });
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#222}code{background:#f3f3f3;padding:2px 6px;border-radius:4px}h1{font-size:22px}</style></head><body>${body}</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.profile) {
    printHelp();
    process.exit(1);
  }
  const profileId = args.profile;
  const upper = profileId.toUpperCase();
  const clientId = process.env[`${upper}_GMAIL_CLIENT_ID`];
  const clientSecret = process.env[`${upper}_GMAIL_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    console.error(
      `error: missing ${upper}_GMAIL_CLIENT_ID and/or ${upper}_GMAIL_CLIENT_SECRET in .env`
    );
    console.error(
      "Create a Desktop OAuth client at https://console.cloud.google.com/apis/credentials"
    );
    process.exit(1);
  }
  const profileRoot = path.resolve(__dirname, "..", "profiles", profileId);
  if (!fs.existsSync(profileRoot)) {
    console.error(`error: profile not found at ${profileRoot}`);
    process.exit(1);
  }
  const tokensDir = path.join(profileRoot, ".gmail-tokens");
  fs.mkdirSync(tokensDir, { recursive: true });
  const tokenPath = path.join(tokensDir, "credentials.json");

  const oAuth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    REDIRECT_URI
  );
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces refresh_token even if previously consented
    scope: SCOPES,
  });

  let resolved = false;
  const server = http.createServer(async (req, res) => {
    const u = url.parse(req.url, true);
    if (u.pathname !== "/oauth-callback") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (resolved) {
      res.writeHead(200);
      res.end("already resolved");
      return;
    }
    const code = u.query.code;
    const oauthErr = u.query.error;
    if (oauthErr) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("OAuth error", `<h1>OAuth error: ${oauthErr}</h1>`));
      console.error(`error: ${oauthErr}`);
      resolved = true;
      server.close();
      process.exit(1);
    }
    if (!code) {
      res.writeHead(400);
      res.end("missing code");
      return;
    }
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      if (!tokens.refresh_token) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          htmlPage(
            "No refresh_token",
            `<h1>No refresh_token returned</h1><p>Revoke this app at <a href="https://myaccount.google.com/permissions">myaccount.google.com</a> → Security → Third-party apps, then re-run.</p>`
          )
        );
        console.error("error: no refresh_token in response");
        console.error(
          "Revoke the prior consent at myaccount.google.com → Security → Third-party apps and re-run."
        );
        resolved = true;
        server.close();
        process.exit(1);
      }
      const out = {
        refresh_token: tokens.refresh_token,
        scope: tokens.scope || SCOPES.join(" "),
        token_type: tokens.token_type || "Bearer",
        obtainedAt: new Date().toISOString(),
        profileId,
      };
      fs.writeFileSync(tokenPath, JSON.stringify(out, null, 2), { mode: 0o600 });
      // Write the fly secrets command to a separate file (mode 0600, gitignored)
      // so the secret never lands in shell scrollback or history.
      const flyCmdPath = path.join(tokensDir, "fly-secret-command.sh");
      const flyCmd =
        `#!/bin/sh\n` +
        `# Run this once when you set up Phase 2 (fly.io cron). Then DELETE this file.\n` +
        `fly secrets set ${upper}_GMAIL_REFRESH_TOKEN='${tokens.refresh_token}' --app ai-job-searcher-cron\n`;
      fs.writeFileSync(flyCmdPath, flyCmd, { mode: 0o600 });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "OK",
          `<h1>✅ Token saved</h1><p>Profile: <code>${profileId}</code></p><p>You can close this tab and return to the terminal.</p>`
        )
      );
      console.log(`✅ refresh_token saved to ${tokenPath}`);
      console.log("");
      console.log("Local smoke test:");
      console.log(`  node engine/cli.js check --profile ${profileId} --auto --dry-run`);
      console.log("");
      console.log("Later (Phase 2 — fly.io cron): fly secrets command saved to");
      console.log(`  ${flyCmdPath}`);
      console.log("  Run it once, then delete the file.");
      resolved = true;
      server.close();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage("Token exchange failed", `<h1>Token exchange failed</h1><pre>${err.message}</pre>`));
      console.error("error: token exchange failed:", err.message);
      resolved = true;
      server.close();
      process.exit(1);
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `error: port ${PORT} already in use. Set GMAIL_AUTH_PORT=<n> and update the OAuth client redirect_uri in Google Cloud Console.`
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, () => {
    console.log(`OAuth callback listening on ${REDIRECT_URI}`);
    console.log("Opening browser for Google consent...");
    openBrowser(authUrl);
    console.log("");
    console.log("If the browser doesn't open, paste this URL manually:");
    console.log(authUrl);
    console.log("");
    console.log(
      "NOTE: register http://localhost:3000/oauth-callback as an Authorized redirect URI"
    );
    console.log(
      "      in your Google Cloud OAuth client (Desktop type) before consenting."
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
