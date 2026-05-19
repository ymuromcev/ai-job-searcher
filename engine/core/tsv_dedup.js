// Dedup duplicate rows in profiles/<id>/applications.tsv.
//
// Why this exists: after the discovery key-prefix migration, some rows are
// stored under a legacy `lever:abc` key while a re-scan inserted the same
// posting as `lever:lever:abc` (the ATS-prefixed jobId got prefixed twice).
// Both rows describe the same job. The runtime workaround is `skip_reason
// = "duplicate"` written by `prepare --phase commit`, but that still leaves
// two rows in TSV — and one of them may have already been pushed to Notion
// while the other accumulated a `fit_score` from a later run. We need to
// collapse the pair to a single canonical row without losing accumulated
// state (fit verdict, cl_path, notion_page_id, …).
//
// Canonical key = (source, normalizedJobId) where normalizedJobId strips
// any leading ATS prefix from `jobId`. Reuses the same `normalizeJobId`
// regex from engine/core/dedup.js so behavior matches scan-time dedup.
//
// Pure module: no I/O. validate.js calls into this for both report
// (dry-run) and rewrite (--apply) paths.

const { normalizeJobId } = require("./dedup.js");

// Higher number = more "advanced" in the pipeline. Used to pick a winner
// when both rows in a collision pair have populated state (e.g. one is
// "Applied", the other "Inbox"). Mirrors the status set documented in
// engine/core/applications_tsv.js (RFC 014).
const STATUS_PRIORITY = {
  Offer: 8,
  Interview: 7,
  Applied: 6,
  "To Apply": 5,
  Inbox: 4,
  "No Response": 3,
  Rejected: 2,
  Closed: 1,
  Archived: 0,
};

// Fields that may have been computed on a "loser" row across earlier runs;
// when the winner's field is empty, lift the loser's value so we don't
// lose work. Status / notion_page_id / createdAt / updatedAt are NOT
// merged — they identify the winner and changing them would break the
// row's identity.
const MERGEABLE_FIELDS = [
  // v5 (RFC 038): single-string `location` replaced by `locations: string[]`.
  // The merge predicate ("lift loser if winner empty") still applies — an
  // empty array on the winner gets replaced by a non-empty array on the loser.
  "locations",
  "resume_ver",
  "cl_key",
  "salary_min",
  "salary_max",
  "cl_path",
  "fit_score",
  "fit_rationale",
  "fit_evaluated_at",
  "skip_reason",
];

// Strip ATS prefixes recursively. `normalizeJobId` peels exactly one layer;
// a triple collision (`lever:abc` ↔ `lever:lever:abc` ↔ `lever:lever:lever:abc`)
// needs full peeling so all three resolve to the same canonical key.
function stripAllPrefixes(id) {
  let prev = String(id || "").trim();
  let cur = normalizeJobId(prev);
  while (cur !== prev) {
    prev = cur;
    cur = normalizeJobId(cur);
  }
  return cur;
}

function canonicalKey(app) {
  const source = String(app.source || "")
    .toLowerCase()
    .trim();
  const id = stripAllPrefixes(app.jobId);
  if (!source || !id) return null;
  return `${source}:${id}`;
}

function statusRank(s) {
  if (Object.prototype.hasOwnProperty.call(STATUS_PRIORITY, s)) {
    return STATUS_PRIORITY[s];
  }
  return -1;
}

function parseTime(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// Suspicious: same canonical key but the rows disagree on company OR the
// URL points to a different posting. We do NOT collapse these — they may
// be a true reuse of an id by the ATS or a data corruption that needs
// human eyes. Surfaced separately in the report.
function normalizeCompanyForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}

function normalizeUrlForCompare(s) {
  if (!s) return "";
  try {
    const u = new URL(s);
    // Strip query+fragment — many ATSes append tracking params that don't
    // change the underlying posting.
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(s).trim().toLowerCase();
  }
}

function rowsAreSuspicious(rows) {
  if (rows.length < 2) return false;
  const companies = new Set(rows.map((r) => normalizeCompanyForCompare(r.companyName)));
  if (companies.size > 1) return true;
  const urls = new Set(rows.map((r) => normalizeUrlForCompare(r.url)));
  // Allow empty url + populated url pair (some legacy rows had no url).
  urls.delete("");
  return urls.size > 1;
}

// Return -1 if a should win over b, 1 if b wins, 0 if tied. Priority order:
//   1. notion_page_id present (has been pushed to Notion → real row)
//   2. status rank (Offer > Interview > … > Archived)
//   3. updatedAt later
//   4. shorter `key` (canonical, no double-prefix)
function compareForWinner(a, b) {
  const aHasPid = !!a.notion_page_id;
  const bHasPid = !!b.notion_page_id;
  if (aHasPid !== bHasPid) return aHasPid ? -1 : 1;

  const aStatus = statusRank(a.status);
  const bStatus = statusRank(b.status);
  if (aStatus !== bStatus) return aStatus > bStatus ? -1 : 1;

  const aTime = parseTime(a.updatedAt);
  const bTime = parseTime(b.updatedAt);
  if (aTime !== bTime) return aTime > bTime ? -1 : 1;

  const aLen = String(a.key || "").length;
  const bLen = String(b.key || "").length;
  if (aLen !== bLen) return aLen < bLen ? -1 : 1;

  return 0;
}

function pickWinner(rows) {
  // Stable: ties (same length etc.) keep first-seen ordering.
  const sorted = [...rows].sort(compareForWinner);
  return sorted[0];
}

function isEmptyMergeable(v) {
  // v5 (RFC 038): `locations` is an array; an empty array means "no
  // location" and should be lifted from a loser if the loser has any.
  // All other mergeable fields are strings — "" / null / undefined count
  // as empty.
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

function mergeLosersInto(winner, losers) {
  const merged = { ...winner };
  for (const field of MERGEABLE_FIELDS) {
    if (!isEmptyMergeable(merged[field])) continue;
    for (const loser of losers) {
      const v = loser[field];
      if (!isEmptyMergeable(v)) {
        merged[field] = v;
        break;
      }
    }
  }
  return merged;
}

function classifyReason(rows) {
  const keys = rows.map((r) => String(r.key || ""));
  // Did any row's `key` differ from its canonical form? That's the
  // signature of legacy-prefix collision (`lever:abc` ↔ `lever:lever:abc`).
  const sources = new Set(rows.map((r) => String(r.source || "").toLowerCase()));
  const source = sources.size === 1 ? Array.from(sources)[0] : "mixed";
  const canon = canonicalKey(rows[0]);
  const anyMismatch = keys.some((k) => k.toLowerCase() !== (canon || "").toLowerCase());
  if (anyMismatch) {
    return `legacy-prefix collision (${source}:X ↔ ${source}:${source}:X)`;
  }
  return `exact key duplicate (${source})`;
}

// Plan dedup: read-only. Returns a structured plan that validate.js can
// either print (dry-run) or apply.
//
//   apps: Array<App> (loaded from applications_tsv.load)
//   returns: {
//     pairs: number,                   // total collision groups (>1 row)
//     kept: Array<App>,                // canonical rows + non-colliding rows
//     dropped: Array<App>,             // losers (with `winnerKey` annotation)
//     suspicious: Array<{ rows, reason }>,  // groups not collapsed
//     byReason: { [reason]: number },  // collision count per reason
//     pairsByGroup: Array<{            // per-group detail for verbose output
//       canonical, reason, winner, losers
//     }>
//   }
function planDedup(apps) {
  if (!Array.isArray(apps)) throw new Error("apps must be an array");

  // Group by canonical key, preserve first-seen ordering inside each
  // group via array (not Map insert order — explicit row-index list).
  const groups = new Map();
  const ungrouped = [];
  for (const app of apps) {
    const ck = canonicalKey(app);
    if (!ck) {
      ungrouped.push(app); // no source/jobId → can't dedup, pass through
      continue;
    }
    if (!groups.has(ck)) groups.set(ck, []);
    groups.get(ck).push(app);
  }

  const kept = [...ungrouped];
  const dropped = [];
  const suspicious = [];
  const pairsByGroup = [];
  const byReason = {};
  let pairs = 0;

  for (const [ck, rows] of groups.entries()) {
    if (rows.length === 1) {
      kept.push(rows[0]);
      continue;
    }
    if (rowsAreSuspicious(rows)) {
      suspicious.push({
        canonical: ck,
        reason: "rows disagree on company or url",
        rows,
      });
      // Suspicious groups are NOT auto-deduped — keep all rows as-is.
      for (const r of rows) kept.push(r);
      continue;
    }
    pairs += 1;
    const winner = pickWinner(rows);
    const losers = rows.filter((r) => r !== winner);
    const reason = classifyReason(rows);
    byReason[reason] = (byReason[reason] || 0) + 1;
    const merged = mergeLosersInto(winner, losers);
    kept.push(merged);
    for (const l of losers) {
      dropped.push({ ...l, winnerKey: winner.key, canonicalKey: ck });
    }
    pairsByGroup.push({ canonical: ck, reason, winner: merged, losers });
  }

  // Preserve original row order in the output as much as possible: walk
  // the input list, replace dropped rows with their winner once, skip the
  // rest. (kept above was append-as-we-go which doesn't preserve order.)
  const winnerByCanonical = new Map(pairsByGroup.map((g) => [g.canonical, g.winner]));
  const droppedKeys = new Set(dropped.map((r) => r.key));
  const orderedKept = [];
  const emittedCanonical = new Set();
  for (const app of apps) {
    if (droppedKeys.has(app.key)) continue;
    const ck = canonicalKey(app);
    if (ck && winnerByCanonical.has(ck)) {
      if (emittedCanonical.has(ck)) continue;
      orderedKept.push(winnerByCanonical.get(ck));
      emittedCanonical.add(ck);
      continue;
    }
    orderedKept.push(app);
  }

  return {
    pairs,
    kept: orderedKept,
    dropped,
    suspicious,
    byReason,
    pairsByGroup,
  };
}

module.exports = {
  planDedup,
  canonicalKey,
  stripAllPrefixes,
  pickWinner,
  mergeLosersInto,
  rowsAreSuspicious,
  STATUS_PRIORITY,
  MERGEABLE_FIELDS,
};
