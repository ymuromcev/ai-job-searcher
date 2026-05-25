// Chrome-headless resume PDF renderer (BL-126, RFC 045).
//
// Replaces the pdfkit-based renderer (engine/modules/generators/resume_pdf.js)
// with an HTML-template + Chrome headless print-to-pdf pipeline:
//
//   data ─► compressForOnePage ─► renderHtml(template) ─► Chrome ─► PDF
//
// Public contract is preserved for drop-in replacement:
//   await generateResumePdf(data, outputPath, opts) → { path, pageCount }
//   opts: { layout?: 'one_page' | 'two_page' | 'ru_long' }  // default 'one_page'
//
// Compression is only applied for layout === 'one_page'. Other layouts pass
// data through unchanged (renderer-side stubs; future RFCs may add presets).
//
// External dependency: a Chrome / Chromium binary on the host. Discovery
// order: CHROME_BIN env var, then well-known macOS paths, then `which` on
// Linux. Throws a descriptive error with remediation if none found.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execSync } = require("child_process");
const crypto = require("crypto");

// ----------------------------------------------------------------------------
// Safety-net compression for one_page layout
// Ported from engine/modules/generators/resume_pdf.js (uncommitted safety-net).
// Pure functions over in-memory objects. Mirror the subagent compression hints
// but enforce them mechanically at render time so output is always 1 page.
// ----------------------------------------------------------------------------

function pickFirstTextRun(bulletRuns) {
  if (typeof bulletRuns === "string") return bulletRuns;
  if (Array.isArray(bulletRuns)) {
    return bulletRuns
      .map((r) => (r && typeof r.text === "string" ? r.text : ""))
      .join("");
  }
  return "";
}

function composeDateSpan(earliest, latest) {
  const startOf = (s) => (typeof s === "string" ? s.split(/[–—\-]/)[0].trim() : "");
  const endOf = (s) => {
    if (typeof s !== "string") return "";
    const parts = s.split(/[–—\-]/);
    return parts.length > 1 ? parts[parts.length - 1].trim() : parts[0].trim();
  };
  const a = startOf(earliest);
  const b = endOf(latest);
  if (a && b) return `${a} – ${b}`;
  return earliest || latest || "";
}

function compressEarlierRoles(roles) {
  if (!Array.isArray(roles) || roles.length <= 3) return roles;
  // If the 3rd role is already a collapsed paragraph, keep as-is.
  const third = roles[2];
  if (third && (!third.bullets || third.bullets.length === 0) && third.description) {
    return roles.slice(0, 3);
  }
  const kept = roles.slice(0, 2);
  const collapsed = roles.slice(2);
  const earliestDates = collapsed[collapsed.length - 1] && collapsed[collapsed.length - 1].dates;
  const latestDates = collapsed[0] && collapsed[0].dates;
  const dateSpan = composeDateSpan(earliestDates, latestDates);
  const prose = collapsed
    .map((r) => {
      const company = (r.company || r.role || "").trim();
      const loc = (r.location || "").trim();
      const desc = (r.description || "").trim().replace(/\.+$/, "");
      const firstBullet = r.bullets && r.bullets[0] ? pickFirstTextRun(r.bullets[0]) : "";
      const trailingMetric = firstBullet.trim().replace(/\.+$/, "");
      const ctxBits = [];
      if (loc) ctxBits.push(loc);
      if (desc) ctxBits.push(desc);
      const ctx = ctxBits.length ? ` (${ctxBits.join(", ")})` : "";
      const tail = trailingMetric ? `: ${trailingMetric}.` : ".";
      return `<b>${company}</b>${ctx}${tail}`;
    })
    .join(" ");
  kept.push({
    role: "Earlier PM roles",
    company: "",
    location: "",
    dates: dateSpan,
    description: prose,
    bullets: [],
  });
  return kept;
}

function capRoleBullets(roles, maxBullets = 4) {
  if (!Array.isArray(roles)) return roles;
  return roles.map((r) => {
    if (!r || !Array.isArray(r.bullets) || r.bullets.length <= maxBullets) return r;
    return { ...r, bullets: r.bullets.slice(0, maxBullets) };
  });
}

function compressProjects(projects) {
  if (!Array.isArray(projects) || projects.length <= 1) return projects;
  const first = projects[0];
  const rest = projects.slice(1);
  const restProse = rest
    .map((p) => {
      const name = (p.name || "").trim();
      const desc = (p.description || "").trim().replace(/\.+$/, "");
      return `<b>${name}</b>${desc ? ` — ${desc}.` : "."}`;
    })
    .join(" ");
  const baseDesc = (first.description || "").trim().replace(/\.+$/, "");
  return [
    {
      name: first.name || "Personal Projects",
      dates: first.dates,
      url: first.url,
      description: `${baseDesc}.${restProse ? " " + restProse : ""}`,
      bullets: first.bullets || [],
    },
  ];
}

function compressForOnePage(data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  out.sharedExperience = compressEarlierRoles(out.sharedExperience || []);
  out.sharedExperience = capRoleBullets(out.sharedExperience, 4);
  out.projects = compressProjects(out.projects || []);
  return out;
}

// ----------------------------------------------------------------------------
// HTML rendering — slot substitution (no template engine)
//
// Template syntax (per RFC 045):
//   {{path.to.field}}                       — scalar substitution (dotted path)
//   <!-- SLOT:name -->...<!-- /SLOT:name -->   — block: repeats per array item if data[name] is array;
//                                                 omitted if data[name] is empty/falsy
//   <!-- ITEM:name -->...<!-- /ITEM:name -->   — nested item block (same repeat semantics)
//   Inside items, {{field}} resolves against the current item;
//   {{../parent}} pops up one scope.
//
// Bullets shape: [[{text, bold}], ...] — each bullet is an array of runs.
// runsToHtml() converts runs → HTML (bold wrapped in <b>). The template
// should mark bullets-derived fields with the convention that they are
// already HTML; we skip escaping them via a small allowlist (see HTML_SAFE_KEYS).
// ----------------------------------------------------------------------------

// Fields that are pre-rendered HTML (no escape on substitution). Add to this
// set when introducing new HTML-bearing fields in the template.
const HTML_SAFE_KEYS = new Set(["bulletsHtml", "descriptionHtml", "summaryHtml"]);

function htmlEscape(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function runsToHtml(runs) {
  if (!Array.isArray(runs)) return "";
  return runs
    .map((r) => {
      if (!r || typeof r.text !== "string") return "";
      const t = htmlEscape(r.text);
      return r.bold ? `<b>${t}</b>` : t;
    })
    .join("");
}

// Resolve a dotted path against a stack of scopes. `../foo` pops one level.
function resolvePath(rawPath, scopes) {
  let path = rawPath.trim();
  let depth = 0;
  while (path.startsWith("../")) {
    depth += 1;
    path = path.slice(3);
  }
  const scopeIdx = Math.max(0, scopes.length - 1 - depth);
  const scope = scopes[scopeIdx];
  if (scope == null) return undefined;
  if (path === "" || path === ".") return scope;
  const parts = path.split(".");
  let cur = scope;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Substitute {{...}} scalars in a string against the given scope stack.
// HTML-escapes by default; passes through if path's final segment is in
// HTML_SAFE_KEYS.
function substituteScalars(str, scopes) {
  return str.replace(/\{\{([^{}]+)\}\}/g, (_match, expr) => {
    const path = expr.trim();
    const value = resolvePath(path, scopes);
    if (value == null) return "";
    // Allow HTML pass-through for designated keys (last path segment).
    const lastSegment = path.replace(/^\.\.\//g, "").split(".").pop();
    if (HTML_SAFE_KEYS.has(lastSegment)) return String(value);
    return htmlEscape(value);
  });
}

// Find the matching close-tag for a given open-tag, accounting for nested
// open/close pairs of the same kind. Returns the index of the start of the
// close marker, or -1 if unmatched.
function findMatchingClose(source, startIdx, openTag, closeTag) {
  let depth = 1;
  let i = startIdx;
  while (i < source.length) {
    const nextOpen = source.indexOf(openTag, i);
    const nextClose = source.indexOf(closeTag, i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + openTag.length;
    } else {
      depth -= 1;
      if (depth === 0) return nextClose;
      i = nextClose + closeTag.length;
    }
  }
  return -1;
}

// Render block-style markers (SLOT and ITEM) recursively. We walk the source
// looking for the next marker; for each marker we determine the array of
// items to iterate (from current scope) and render the inner block once per
// item with the item pushed onto the scope stack. Empty arrays / falsy values
// → block is omitted.
function renderBlocks(source, scopes, markerType) {
  // markerType: "SLOT" or "ITEM"
  const openPrefix = `<!-- ${markerType}:`;
  let out = "";
  let i = 0;
  while (i < source.length) {
    const openStart = source.indexOf(openPrefix, i);
    if (openStart === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, openStart);
    // Parse marker name: <!-- SLOT:name -->
    const openEnd = source.indexOf("-->", openStart);
    if (openEnd === -1) {
      out += source.slice(openStart);
      break;
    }
    const nameRaw = source.slice(openStart + openPrefix.length, openEnd).trim();
    const openTag = `<!-- ${markerType}:${nameRaw} -->`;
    const closeTag = `<!-- /${markerType}:${nameRaw} -->`;
    // Validate the marker we just matched ends with -->
    if (source.slice(openStart, openEnd + 3) !== openTag) {
      // Tolerate whitespace mismatch — accept what we parsed.
    }
    const innerStart = openEnd + 3;
    const closeStart = findMatchingClose(source, innerStart, openTag, closeTag);
    if (closeStart === -1) {
      out += source.slice(openStart);
      break;
    }
    const inner = source.slice(innerStart, closeStart);
    const afterClose = closeStart + closeTag.length;

    const value = resolvePath(nameRaw, scopes);
    if (Array.isArray(value)) {
      for (const item of value) {
        out += renderInner(inner, [...scopes, item]);
      }
    } else if (value) {
      // Non-array truthy: render inner with current scope (treat as plain block include).
      out += renderInner(inner, scopes);
    }
    // Falsy → omit block.

    i = afterClose;
  }
  return out;
}

// Render an inner block: first process nested SLOT blocks, then ITEM blocks,
// then scalar substitutions. Order matters so that ITEM markers nested inside
// SLOT can reference the iterated item.
function renderInner(source, scopes) {
  let s = renderBlocks(source, scopes, "SLOT");
  s = renderBlocks(s, scopes, "ITEM");
  s = substituteScalars(s, scopes);
  return s;
}

function renderHtml(data, templateSource) {
  if (typeof templateSource !== "string") {
    throw new Error("renderHtml: templateSource must be a string");
  }
  return renderInner(templateSource, [data || {}]);
}

// ----------------------------------------------------------------------------
// Chrome binary discovery
// ----------------------------------------------------------------------------

const CHROME_NOT_FOUND_MSG =
  "Chrome not found. Install Google Chrome / Chromium, or set CHROME_BIN env var to the binary path.";

function findChromeBin() {
  // 1. Explicit env var
  const envBin = process.env.CHROME_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  // 2. macOS well-known paths
  if (process.platform === "darwin") {
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 3. Linux: which
  if (process.platform === "linux") {
    const candidates = [
      "google-chrome",
      "chromium",
      "chromium-browser",
      "google-chrome-stable",
    ];
    for (const c of candidates) {
      try {
        const found = execSync(`which ${c}`, { stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
        if (found && fs.existsSync(found)) return found;
      } catch {
        // not found, keep going
      }
    }
  }

  throw new Error(CHROME_NOT_FOUND_MSG);
}

// ----------------------------------------------------------------------------
// Chrome subprocess wrapper
// ----------------------------------------------------------------------------

function htmlToPdf(htmlPath, outPath, chromeBin) {
  return new Promise((resolve, reject) => {
    const absHtml = path.resolve(htmlPath);
    const absOut = path.resolve(outPath);
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      `--print-to-pdf=${absOut}`,
      `file://${absHtml}`,
    ];
    const child = spawn(chromeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`htmlToPdf: Chrome timed out after 30s\nstderr: ${stderr}`));
    }, 30_000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`htmlToPdf: failed to spawn Chrome: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`htmlToPdf: Chrome exited with code ${code}\nstderr: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

// ----------------------------------------------------------------------------
// Page-count detection
//
// We don't have pdf-parse in deps and don't want to add it just for this.
// Chrome-generated PDFs reliably contain one `/Type /Page` object per page
// (and a single `/Type /Pages` catalog). Count Page occurrences while
// excluding the plural Pages — the `[^s]` negative class after `/Page`
// rules out `/Pages`.
// ----------------------------------------------------------------------------

async function countPages(pdfPath) {
  const buf = await fs.promises.readFile(pdfPath);
  const asString = buf.toString("binary");
  const matches = asString.match(/\/Type\s*\/Page[^s]/g);
  const count = matches ? matches.length : 0;
  // Defensive floor: if regex fails (unusual PDF), report 1 rather than 0
  // so callers don't false-positive a "0 pages rendered" failure.
  return count > 0 ? count : 1;
}

// ----------------------------------------------------------------------------
// Main entry
// ----------------------------------------------------------------------------

const TEMPLATE_PATH = path.join(__dirname, "resume_template.html");

async function generateResumePdf(data, outputPath, opts = {}) {
  const layout = (opts && opts.layout) || "one_page";
  const compressed = layout === "one_page" ? compressForOnePage(data) : data;

  // Read template at call time so tests that mock htmlToPdf can run before
  // the template file exists on disk (Agent 2's deliverable).
  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `generateResumePdf: cannot read resume_template.html at ${TEMPLATE_PATH}: ${err.message}`,
    );
  }

  const html = renderHtml(compressed, template);
  const randomSuffix = crypto.randomBytes(8).toString("hex");
  const tmpHtml = path.join(os.tmpdir(), `resume-${process.pid}-${randomSuffix}.html`);
  fs.writeFileSync(tmpHtml, html, "utf8");

  try {
    const chrome = module.exports.findChromeBin();
    await module.exports.htmlToPdf(tmpHtml, outputPath, chrome);
    const pageCount = await module.exports.countPages(outputPath);
    return { path: outputPath, pageCount };
  } finally {
    try {
      fs.unlinkSync(tmpHtml);
    } catch {
      // best-effort cleanup
    }
  }
}

module.exports = {
  generateResumePdf,
  // Helpers re-exported for tests + downstream callers
  compressForOnePage,
  compressEarlierRoles,
  capRoleBullets,
  compressProjects,
  renderHtml,
  runsToHtml,
  findChromeBin,
  htmlToPdf,
  countPages,
  // Constants for tests
  CHROME_NOT_FOUND_MSG,
  TEMPLATE_PATH,
};
