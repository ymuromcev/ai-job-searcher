// Expected Status select/status-property options for the per-profile Jobs
// Pipeline DB in Notion. Pipeline-side, statuses are split (RFC 014):
//
//   - `Inbox` is intentionally LOCAL-ONLY (TSV) and never appears on Notion.
//   - All other 8 are pipeline-managed and expected to exist as Status options.
//
// Single source of truth so `validate` can warn early if a user renamed /
// deleted one (e.g. "Applied" → "Submitted"), instead of failing later inside
// `pages.update` with an opaque `validation_error` from the Notion API.

const EXPECTED_STATUS_OPTIONS = [
  "To Apply",
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "No Response",
  "Closed",
  "Archived",
];

// Pure: pulls the Status-property options out of a Notion data_source schema
// object (the shape returned by `client.dataSources.retrieve`). Returns an
// array of option name strings. Tolerates both `status` and `select` types
// since profiles in the wild have used either.
function extractStatusOptions(dataSource, fieldName = "Status") {
  const props = dataSource && dataSource.properties;
  if (!props || typeof props !== "object") return null;
  const prop = props[fieldName];
  if (!prop || typeof prop !== "object") return null;
  const bucket = prop.status || prop.select;
  if (!bucket || !Array.isArray(bucket.options)) return null;
  return bucket.options.map((o) => o && o.name).filter((n) => typeof n === "string");
}

// Pure: compares actual options against expected. `missing` = expected names
// that aren't in actual. `extras` are options the user added on top — we
// report them but they're NOT a failure (warn-only).
function checkStatusSchema(actualOptions, expected = EXPECTED_STATUS_OPTIONS) {
  const actualSet = new Set(actualOptions || []);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const extras = (actualOptions || []).filter((name) => !expectedSet.has(name));
  return { ok: missing.length === 0, missing, extras };
}

module.exports = {
  EXPECTED_STATUS_OPTIONS,
  extractStatusOptions,
  checkStatusSchema,
};
