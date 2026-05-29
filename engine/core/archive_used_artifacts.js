// Archive used tailored artifacts.
//
// For TSV rows whose status moved past `To Apply` (i.e. the operator has
// committed to / heard back from the job), move the engine-generated
// tailored DOCX/PDF from its hot location into a month-bucketed archive
// directory. Rewrite `resume_ver` / `cl_path` in the TSV to the new
// archive paths so the Notion-linked file URL keeps resolving.
//
// Two phases:
//   planArchiveMoves({rows, profileRoot, fs, now})  — pure, no side effects.
//   applyArchiveMoves(plan, {fs, tsvUpdater, logger}) — performs the moves
//                                                       and TSV mutations.
//
// Operator-confirmed decisions (BL-151, RFC 054):
//   - Trigger statuses: Applied, Interview, Offer, Rejected, Closed,
//     No Response. (Active statuses Inbox / To Apply / In Review stay
//     in place.)
//   - Archive layout: <profileRoot>/cv/archive/YYYY-MM/<basename>
//                     <profileRoot>/cover_letters/archive/YYYY-MM/<basename>
//     YYYY-MM derived from row.updatedAt → row.createdAt → "unknown".
//   - Archetype detection: a path is treated as a tailored artifact iff
//     it starts with one of TAILORED_PREFIXES. Any other path is treated
//     as an archetype (referenced by name or living elsewhere) and is
//     never moved.

const path = require("path");

const TRIGGER_STATUSES = new Set([
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "Closed",
  "No Response",
]);

// Paths starting with any of these prefixes (POSIX, forward-slash) are
// considered engine-tailored artifacts. Everything else is an archetype
// and never archived. Keep in sync with `engine/modules/tailor/dispatcher.js`
// (RFC 044) and the cover-letter generator output convention.
const TAILORED_PREFIXES = ["cv/tailored/", "resumes/tailored/", "cover_letters/tailored/"];

function isTailoredPath(p) {
  if (!p || typeof p !== "string") return false;
  // Normalize backslashes defensively (hand edits on Windows-style paths).
  const norm = p.replace(/\\/g, "/");
  return TAILORED_PREFIXES.some((prefix) => norm.startsWith(prefix));
}

// Pick the date used to bucket the archive directory.
//   1. row.updatedAt (closest to the status-change moment in the v5 schema)
//   2. row.createdAt
//   3. "unknown" — falls into <archiveDir>/unknown/ rather than crashing.
function bucketMonth(row) {
  for (const cand of [row && row.updatedAt, row && row.createdAt]) {
    if (!cand || typeof cand !== "string") continue;
    // Accept any ISO-ish prefix YYYY-MM-...
    const m = cand.match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  return "unknown";
}

// Compute the target archive path for a hot tailored file.
//   relPath = e.g. "resumes/tailored/affirm_pm_20260520.docx"
//   kind    = "cv" | "cl"
//   yyyymm  = "2026-05" | "unknown"
// Returns a forward-slash relative path under <profileRoot>:
//   cv/archive/2026-05/affirm_pm_20260520.docx
//   cover_letters/archive/2026-05/affirm_pm_20260520.pdf
function archiveTargetFor(relPath, kind, yyyymm) {
  const base = path.posix.basename(relPath.replace(/\\/g, "/"));
  const archiveRoot = kind === "cv" ? "cv/archive" : "cover_letters/archive";
  return path.posix.join(archiveRoot, yyyymm, base);
}

// Classify a row → which artifact fields are eligible to archive.
function eligibleArtifacts(row) {
  if (!row || !TRIGGER_STATUSES.has(row.status)) return [];
  const out = [];
  if (isTailoredPath(row.resume_ver)) {
    out.push({ kind: "cv", field: "resume_ver", relPath: row.resume_ver });
  }
  if (isTailoredPath(row.cl_path)) {
    out.push({ kind: "cl", field: "cl_path", relPath: row.cl_path });
  }
  return out;
}

/**
 * Pure planner. Walks the TSV rows and builds a plan of intended file
 * moves + TSV mutations. No filesystem writes, no TSV writes.
 *
 * @param {object} args
 * @param {Array<object>} args.rows      — TSV row objects (see applications_tsv.js).
 * @param {string} args.profileRoot      — absolute path to the profile root
 *                                          (e.g. /…/profiles/lilia). All move
 *                                          paths in the plan are absolute,
 *                                          relative paths in the TSV stay
 *                                          relative to this root.
 * @param {object} args.fs               — facade {existsSync}. mkdirSync /
 *                                          renameSync are needed only at apply
 *                                          time; the planner only checks
 *                                          existsSync to compute moves vs skips.
 * @returns {{moves: Array, skipped: Array, warnings: string[]}}
 */
function planArchiveMoves({ rows, profileRoot, fs }) {
  const moves = [];
  const skipped = [];
  const warnings = [];

  if (!Array.isArray(rows)) return { moves, skipped, warnings };
  if (!profileRoot || typeof profileRoot !== "string") {
    warnings.push("archive: missing profileRoot — skipping plan");
    return { moves, skipped, warnings };
  }

  for (const row of rows) {
    const arts = eligibleArtifacts(row);
    if (arts.length === 0) continue;

    const yyyymm = bucketMonth(row);
    for (const art of arts) {
      const fromAbs = path.join(profileRoot, art.relPath);
      const toRel = archiveTargetFor(art.relPath, art.kind, yyyymm);
      const toAbs = path.join(profileRoot, toRel);

      const sourceExists = fs.existsSync(fromAbs);
      const targetExists = fs.existsSync(toAbs);

      if (!sourceExists) {
        skipped.push({
          path: art.relPath,
          reason: "source-missing",
          rowKey: row.key,
          kind: art.kind,
          field: art.field,
        });
        warnings.push(
          `archive: source missing for ${row.key} (${art.field}=${art.relPath}) — skipped`
        );
        continue;
      }
      if (targetExists) {
        skipped.push({
          path: art.relPath,
          reason: "target-exists",
          rowKey: row.key,
          kind: art.kind,
          field: art.field,
        });
        warnings.push(
          `archive: target exists for ${row.key} (${toRel}) — not overwriting`
        );
        continue;
      }

      moves.push({
        from: fromAbs,
        to: toAbs,
        fromRel: art.relPath,
        toRel,
        rowKey: row.key,
        kind: art.kind,
        field: art.field,
      });
    }
  }
  return { moves, skipped, warnings };
}

/**
 * Apply a plan: mkdirp the target directory, rename the file, and call
 * `tsvUpdater(rowKey, patch)` so the caller can mutate the in-memory
 * TSV row (then save it after all moves succeed).
 *
 * @param {object} plan                  — output of planArchiveMoves.
 * @param {object} deps
 * @param {object} deps.fs               — facade {mkdirSync, renameSync}.
 * @param {function} deps.tsvUpdater     — (rowKey, patch) → void.
 * @param {object} [deps.logger]         — {warn(msg), info(msg)} (optional).
 * @returns {{moved: number, skipped: number, warnings: string[], byMonth: object}}
 */
function applyArchiveMoves(plan, { fs, tsvUpdater, logger }) {
  const warnings = (plan && plan.warnings ? plan.warnings.slice() : []);
  let moved = 0;
  const byMonth = { cv: new Set(), cl: new Set() };

  if (!plan || !Array.isArray(plan.moves)) {
    return { moved: 0, skipped: 0, warnings, byMonth: { cv: [], cl: [] } };
  }

  for (const m of plan.moves) {
    try {
      fs.mkdirSync(path.dirname(m.to), { recursive: true });
      fs.renameSync(m.from, m.to);
      if (typeof tsvUpdater === "function") {
        const patch = {};
        patch[m.field] = m.toRel;
        tsvUpdater(m.rowKey, patch);
      }
      // Track YYYY-MM directory for stdout summary.
      const monthDir = path.posix.dirname(m.toRel.replace(/\\/g, "/"));
      if (m.kind === "cv") byMonth.cv.add(monthDir);
      else byMonth.cl.add(monthDir);
      moved += 1;
    } catch (err) {
      const msg = `archive: failed to move ${m.fromRel} → ${m.toRel}: ${err.message}`;
      warnings.push(msg);
      if (logger && typeof logger.warn === "function") logger.warn(msg);
    }
  }

  return {
    moved,
    skipped: Array.isArray(plan.skipped) ? plan.skipped.length : 0,
    warnings,
    byMonth: {
      cv: Array.from(byMonth.cv).sort(),
      cl: Array.from(byMonth.cl).sort(),
    },
  };
}

module.exports = {
  planArchiveMoves,
  applyArchiveMoves,
  isTailoredPath,
  bucketMonth,
  archiveTargetFor,
  TRIGGER_STATUSES,
  TAILORED_PREFIXES,
};
