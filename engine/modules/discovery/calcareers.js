// CalCareers (State of California public jobs board) adapter.
//
// Site is ASP.NET WebForms with no public JSON API. We emulate a postback:
//   1) GET JobSearchResults.aspx          → extract __VIEWSTATE / _VALIDATION / cookie
//   2) POST with keyword filter           → first page of results
//   3) POST switching rowCount 10 → 100   → dense page
//   4) POST paged clicks ctl01..ctl09     → pages 2..10 (hard cap, per legacy)
//
// Target shape: { name, slug, keyword }
//   One target = one keyword search. Multiple targets are fanned out with
//   low concurrency (the site is sensitive to rapid postbacks).
//
// This adapter does NOT classify jobs by ITM/ITS or score fit — profile-
// specific logic belongs in core/filter.js.

const { runTargets, makeCtx } = require("./_ats.js");
const { assertJob } = require("./_types.js");
const { sanitizeText, parseIsoDate } = require("./_normalize.js");

const SOURCE = "calcareers";
const BASE = "https://calcareers.ca.gov";
const SEARCH_URL = `${BASE}/CalHRPublic/Search/JobSearchResults.aspx`;

const PAGE_SIZE = 100;
const HARD_CAP_PAGES = 10;
const DEFAULT_STEP_DELAY_MS = 800;
const DEFAULT_KEYWORD_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getHidden(html, name) {
  const m = html.match(new RegExp(`name="${name}"[^>]+value="([^"]*)"`));
  return m ? m[1] : "";
}

function extractCookie(res) {
  const getter =
    (res.headers && typeof res.headers.getSetCookie === "function" && res.headers.getSetCookie()) ||
    null;
  const list = getter || (res.headers && res.headers.get && [res.headers.get("set-cookie")]) || [];
  const first = Array.isArray(list) ? list.find(Boolean) : list;
  if (!first) return "";
  return String(first).split(";")[0];
}

function labeledFields(block) {
  const clean = block
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fields = {};
  const labels = [
    "Working Title",
    "Job Control",
    "Salary Range",
    "Work Type/Schedule",
    "Department",
    "Location",
    "Telework",
    "Publish Date",
    "Filing Deadline",
  ];
  for (let i = 0; i < labels.length; i += 1) {
    const cur = labels[i];
    const next =
      labels
        .slice(i + 1)
        .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|") || "View Job Posting|$";
    const re = new RegExp(
      `${cur.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*?)\\s*(?:${next})`,
      "i"
    );
    const m = clean.match(re);
    if (m) fields[cur] = m[1].trim();
  }
  return fields;
}

function extractRowsHtml(html) {
  const anchorRe =
    /<a[^>]+id="cphMainContent_rptResults_hlViewJobPosting_(\d+)"[^>]+href="([^"]*JobControlId=(\d+))"[^>]*>([^<]+)<\/a>/g;
  const matches = [...html.matchAll(anchorRe)];
  const rows = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const blockStart = m.index;
    const blockEnd =
      i + 1 < matches.length ? matches[i + 1].index : Math.min(blockStart + 6000, html.length);
    const block = html.slice(blockStart, blockEnd);
    const title = m[4].trim();
    const jobControlId = m[3];
    const url = m[2].startsWith("http") ? m[2] : BASE + m[2];
    const f = labeledFields(block);
    rows.push({
      jobControlId,
      title,
      url,
      workingTitle: f["Working Title"] || "",
      department: f["Department"] || "",
      location: f["Location"] || "",
      salary: f["Salary Range"] || "",
      workType: f["Work Type/Schedule"] || "",
      telework: f["Telework"] || "",
      publishDate: f["Publish Date"] || "",
      finalFilingDate: f["Filing Deadline"] || "",
    });
  }
  return rows;
}

function parseMdyDate(raw) {
  const m = String(raw || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return parseIsoDate(iso);
}

function mapRow(target, row) {
  const locations = row.location ? [sanitizeText(row.location)] : [];
  const title = sanitizeText(row.workingTitle || row.title);
  const job = {
    source: SOURCE,
    slug: target.slug,
    companyName: sanitizeText(row.department) || target.name,
    jobId: String(row.jobControlId),
    title,
    url: row.url,
    locations,
    team: null,
    postedAt: parseMdyDate(row.publishDate),
    rawExtra: {
      salary: row.salary || null,
      workType: row.workType || null,
      telework: row.telework || null,
      finalFilingDate: row.finalFilingDate || null,
    },
  };
  assertJob(job);
  return job;
}

async function fetchText(fetchFn, url, opts, signal) {
  const res = await fetchFn(url, { ...opts, signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  const text = typeof res.text === "function" ? await res.text() : res.body;
  return { text: text || "", cookie: extractCookie(res) };
}

function stateForm(curBody, extras) {
  return new URLSearchParams({
    __VIEWSTATE: getHidden(curBody, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: getHidden(curBody, "__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: getHidden(curBody, "__EVENTVALIDATION"),
    "ctl00$cphMainContent$hdnSearchCriteria": "",
    ...extras,
  }).toString();
}

async function scanKeyword(fetchFn, target, signal, delays, logger) {
  const kw = target.keyword;
  const rows = [];
  const stepDelay = delays.stepMs;
  const warn = (logger && logger.warn) || (() => {});

  // 1) initial GET for cookie + VIEWSTATE.
  const initial = await fetchText(fetchFn, SEARCH_URL, { method: "GET" }, signal);
  if (!getHidden(initial.text, "__VIEWSTATE")) {
    throw new Error("calcareers: no viewstate in initial response");
  }

  // 2) POST: keyword search (default rowCount=10).
  const search1Body = stateForm(initial.text, {
    __EVENTTARGET: "ctl00$cphMainContent$btnUpdateResults",
    __EVENTARGUMENT: "",
    "ctl00$cphMainContent$txtKeyword": kw,
  });
  const search1 = await fetchText(
    fetchFn,
    SEARCH_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: initial.cookie,
      },
      body: search1Body,
    },
    signal
  );
  let curBody = search1.text;
  const totalMatch = curBody.match(/ResultCount[^>]*>(\d+)/);
  const totalResults = totalMatch ? Number(totalMatch[1]) : 0;
  const firstPageRows = extractRowsHtml(curBody);
  if (totalResults === 0 && firstPageRows.length > 0) {
    // Result count marker went missing but we still see job anchors — likely
    // a markup change on calcareers.ca.gov. Warn loudly so the user notices
    // that we're silently skipping the rowCount switch and pagination.
    warn(
      `[${SOURCE}] ${target.slug}: ResultCount marker missing but ${firstPageRows.length} rows on page — CalCareers HTML may have changed`
    );
  }

  // 3) POST: switch rowCount → 100.
  if (totalResults > 10) {
    await sleep(stepDelay);
    const denseBody = stateForm(curBody, {
      __EVENTTARGET: "ctl00$cphMainContent$ddlRowCount",
      __EVENTARGUMENT: "",
      "ctl00$cphMainContent$txtKeyword": kw,
      "ctl00$cphMainContent$ddlRowCount": String(PAGE_SIZE),
    });
    const dense = await fetchText(
      fetchFn,
      SEARCH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: initial.cookie,
        },
        body: denseBody,
      },
      signal
    );
    curBody = dense.text;
  }
  rows.push(...extractRowsHtml(curBody));

  // 4) POST: pages 2..10.
  const totalPages = Math.min(HARD_CAP_PAGES, Math.max(1, Math.ceil(totalResults / PAGE_SIZE)));
  for (let page = 2; page <= totalPages; page += 1) {
    const btnIdx = String(page - 1).padStart(2, "0");
    if (
      !curBody.includes(`ctl${btnIdx}$btnPagerItem`) &&
      !curBody.includes(`ctl${btnIdx}_btnPagerItem`)
    ) {
      break;
    }
    await sleep(stepDelay);
    const pagedBody = stateForm(curBody, {
      __EVENTTARGET: `ctl00$cphMainContent$ucRepeaterPager$rptPager$ctl${btnIdx}$btnPagerItem`,
      __EVENTARGUMENT: "",
      "ctl00$cphMainContent$txtKeyword": kw,
      "ctl00$cphMainContent$ddlRowCount": String(PAGE_SIZE),
    });
    const paged = await fetchText(
      fetchFn,
      SEARCH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: initial.cookie,
        },
        body: pagedBody,
      },
      signal
    );
    curBody = paged.text;
    const pageRows = extractRowsHtml(curBody);
    if (!pageRows.length) break;
    rows.push(...pageRows);
  }

  // Deduplicate by jobControlId (keyword overlaps are normal).
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    if (!r.jobControlId || seen.has(r.jobControlId)) continue;
    seen.add(r.jobControlId);
    unique.push(r);
  }
  return unique.map((r) => mapRow(target, r));
}

async function discover(targets, ctx = {}) {
  const c = makeCtx({ ...ctx, source: SOURCE });
  const delays = {
    stepMs: Number.isFinite(ctx.stepDelayMs) ? ctx.stepDelayMs : DEFAULT_STEP_DELAY_MS,
    keywordMs: Number.isFinite(ctx.keywordDelayMs)
      ? ctx.keywordDelayMs
      : DEFAULT_KEYWORD_DELAY_MS,
  };
  const effectiveCtx = { ...c, concurrency: 1 };
  const out = await runTargets(targets, effectiveCtx, async (target) => {
    if (!target || !target.keyword) return [];
    const jobs = await scanKeyword(c.fetchFn, target, c.signal, delays, c.logger);
    await sleep(delays.keywordMs);
    return jobs;
  });
  return out;
}

module.exports = { source: SOURCE, discover };
