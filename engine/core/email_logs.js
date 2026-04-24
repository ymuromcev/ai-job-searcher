// Human-readable log writers for check command.
// Ported from ../../Job Search/check_emails.js:269-283, 619-722 (prototype).
//
// All log files live at profiles/<id>/*.md. All writers are append-ish: they
// either insert new rows into an existing structure or create the file with
// a header block if missing.

const fs = require("fs");

const RECRUITER_LEADS_HEADER =
  "# Recruiter Leads\n\nПисьма от рекрутеров без указанной компании-клиента.\n\n" +
  "| Date | Agency | Role | Contact | Subject |\n" +
  "|------|--------|------|---------|---------|";

function appendRecruiterLeads(filePath, leads) {
  if (!leads || leads.length === 0) return;
  let log = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : RECRUITER_LEADS_HEADER + "\n";
  const rows = leads.map(
    (l) =>
      `| ${l.date} | ${l.agency} | ${l.role} | ${l.contact} | ${(l.subject || "").replace(/\|/g, "/")} |`
  );
  log += rows.join("\n") + "\n";
  fs.writeFileSync(filePath, log);
}

// Rejections are inserted before the "## Patterns Observed" section (if
// present). Counters ("**Rejected**: N", "**Pending (Applied)**: N") are
// updated in-place.
function appendRejectionLog(filePath, rejections, now = new Date()) {
  if (!rejections || rejections.length === 0) return;
  let log = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const today = now.toISOString().slice(0, 10);

  const newRows = rejections
    .map(
      (r) =>
        `| ${today} | ${r.company} | ${r.role} | ${r.level || "—"} | — | ${r.arch || "—"} | High competition, automated check | Email ${today}. Updated Notion → Rejected ${today}. |`
    )
    .join("\n");

  if (log.includes("## Patterns Observed")) {
    log = log.replace(/(\n## Patterns Observed)/, `\n${newRows}$1`);
  } else if (log.length === 0) {
    log =
      "# Rejection Log\n\nTrack rejections, patterns, and strategy adjustments.\n\n## Rejections\n\n" +
      "| Date | Company | Role | Level | Fit Score | CV Archetype | Possible Reason | Notes |\n" +
      "|---|---|---|---|---|---|---|---|\n" +
      newRows +
      "\n";
  } else {
    log += `\n${newRows}\n`;
  }

  log = log.replace(
    /(-\s*\*\*Rejected\*\*:\s*)(\d+)([^\n]*)/,
    (_, pre, num) => {
      const names = rejections.map((r) => r.company).join(", ");
      return `${pre}${parseInt(num, 10) + rejections.length} (+${rejections.length} from email check ${today}: ${names})`;
    }
  );

  const appliedCount = rejections.filter((r) => r.prevApplied).length;
  if (appliedCount > 0) {
    log = log.replace(
      /(-\s*\*\*Pending \(Applied\)\*\*:\s*)(\d+)/,
      (_, pre, num) => `${pre}${Math.max(0, parseInt(num, 10) - appliedCount)}`
    );
  }

  fs.writeFileSync(filePath, log);
}

// Builds the short human summary shown on stdout and at the top of each
// check-log entry.
function buildSummary({
  rejections = [],
  logRows = [],
  actionCount = 0,
  inboxAdded = 0,
  recruiterLeadsCount = 0,
} = {}) {
  const pipelineRows = logRows.filter(
    (r) => r.type !== "LINKEDIN_LEAD" && r.type !== "RECRUITER_OUTREACH"
  );
  if (pipelineRows.length === 0 && inboxAdded === 0 && recruiterLeadsCount === 0) {
    return "Новых ответов по вакансиям не найдено.";
  }
  const parts = [];
  if (rejections.length > 0) {
    parts.push(
      `${rejections.length} отказ${rejections.length > 1 ? "а" : ""} (${rejections
        .map((r) => r.company)
        .join(", ")})`
    );
  }
  const interviews = logRows.filter((r) =>
    (r.action || "").includes("Interview")
  );
  if (interviews.length > 0) {
    parts.push(
      `🔔 ${interviews.length} приглашение на интервью (${interviews.map((r) => r.company).join(", ")})`
    );
  }
  const infoReqs = logRows.filter(
    (r) => r.type === "INFO_REQUEST" && (r.action || "").includes("comment_only")
  );
  if (infoReqs.length > 0) parts.push(`${infoReqs.length} запрос информации`);
  if (inboxAdded > 0)
    parts.push(`📥 ${inboxAdded} новых в Inbox (LinkedIn/рекрутеры)`);
  if (recruiterLeadsCount > 0)
    parts.push(`📋 ${recruiterLeadsCount} рекрутерских лидов → recruiter_leads.md`);
  if (parts.length === 0) {
    return `${pipelineRows.length} писем обработано, действий не требуется.`;
  }
  return parts.join(", ") + ".";
}

// New entries are inserted right after the first "---\n\n" separator, so the
// file reads newest-first.
function appendCheckLog(filePath, {
  logRows = [],
  actionCount = 0,
  rejections = [],
  inboxAdded = 0,
  recruiterLeadsCount = 0,
  now = new Date(),
} = {}) {
  const dateStr = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const matched = logRows.filter((r) => r.match !== "NONE").length;

  const tableRows =
    logRows.length > 0
      ? logRows
          .map(
            (r) =>
              `| ${r.id} | ${r.company} | ${(r.role || "").slice(0, 40)} | ${r.match} | ${r.type} | ${r.action} | ${r.comment || "—"} |`
          )
          .join("\n")
      : "| — | — | — | — | — | — | — |";

  const unmatched = logRows.filter((r) => r.match === "NONE");
  const unmatchedStr =
    unmatched.length > 0
      ? `\n**Unmatched**: ${unmatched.map((r) => `${r.id} (${r.type})`).join(", ")}\n`
      : "";

  const summary = buildSummary({
    rejections,
    logRows,
    actionCount,
    inboxAdded,
    recruiterLeadsCount,
  });

  const entry = `## Check: ${dateStr}

**Emails found**: ${logRows.length} | **Matched**: ${matched} | **Actions**: ${actionCount}

| Gmail ID | Company | Role | Match | Type | Action | Comment |
|----------|---------|------|-------|------|--------|---------|
${tableRows}
${unmatchedStr}
**Summary**: ${summary}

---

`;

  let log = "";
  if (fs.existsSync(filePath)) {
    log = fs.readFileSync(filePath, "utf8");
    log = log.replace(/(---\n\n)(## Check:)/, `$1${entry}$2`);
    if (!log.includes(entry.slice(0, 20))) {
      log = log.replace(/(---\n\n)/, `$1${entry}`);
    }
  } else {
    log = `# Email Check Log\n\nАвтоматические проверки ответов по вакансиям.\n\n---\n\n${entry}`;
  }

  fs.writeFileSync(filePath, log);
}

module.exports = {
  appendRecruiterLeads,
  appendRejectionLog,
  appendCheckLog,
  buildSummary,
};
