// property_map.js — resolve the Notion Jobs DB property_map for a profile
// given its enabled modules + optional flags.
//
// Per RFC 004 §4.7: core fields always, feature-gated fields only if the
// triggering module is active.
//
// Returns:
//   - `propertyMap`: object used by profile.json.notion.property_map
//   - `notionSchema`: object used by Notion dataSources.update / initial_data_source
//     (same field names, Notion-native shape with options for select/status)
//
// These two are intentionally separate because the internal code uses simple
// {field, type} while Notion needs full type-specific bodies.

// Core — always emitted.
const CORE_FIELDS = {
  title:         { field: "Title",        type: "title" },
  companyName:   { field: "Company",      type: "relation" },
  source:        { field: "Source",       type: "select" },
  jobId:         { field: "JobID",        type: "rich_text" },
  url:           { field: "URL",          type: "url" },
  status:        { field: "Status",       type: "status" },
  key:           { field: "Key",          type: "rich_text" },
  dateAdded:     { field: "Date Added",   type: "date" },
  notes:         { field: "Notes",        type: "rich_text" },
};

// Module-gated groups. Key: module id (string present in intake.modules
// or one of the synthetic flags below). Value: {internal: {field, type}}.
const GATED_GROUPS = {
  "prepare": {
    salaryMin:         { field: "Salary Min",           type: "number" },
    salaryMax:         { field: "Salary Max",           type: "number" },
    salaryExpectations:{ field: "Salary Expectations",  type: "rich_text" },
    workFormat:        { field: "Work Format",          type: "select" },
    city:              { field: "City",                 type: "rich_text" },
    state:             { field: "State",                type: "rich_text" },
    fitScore:          { field: "Fit Score",            type: "select" },
    resumeVersion:     { field: "Resume Version",       type: "select" },
    coverLetter:       { field: "Cover Letter",         type: "rich_text" },
    datePosted:        { field: "Date Posted",          type: "date" },
    dateApplied:       { field: "Date Applied",         type: "date" },
  },
  "check": {
    lastFollowup:  { field: "Last Follow-up", type: "date" },
    nextFollowup:  { field: "Next Follow-up", type: "date" },
  },
  "discovery:calcareers": {
    classification:  { field: "Classification",    type: "rich_text" },
    jobControlId:    { field: "Job Control ID",    type: "rich_text" },
    soqRequired:     { field: "SOQ Required",      type: "checkbox" },
    soqSubmitted:    { field: "SOQ Submitted",     type: "checkbox" },
    finalFilingDate: { field: "Final Filing Date", type: "date" },
  },
  "watcher": {
    watcher: { field: "Watcher", type: "people" },
  },
};

// Notion schema bodies for each field. Must match the field types above.
// Factored out to keep createJobsDb() reasonable.
function toNotionSchema(propertyMap) {
  const schema = {};
  for (const spec of Object.values(propertyMap)) {
    const { field, type } = spec;
    switch (type) {
      case "title":
        schema[field] = { type: "title", title: {} };
        break;
      case "rich_text":
        schema[field] = { type: "rich_text", rich_text: {} };
        break;
      case "url":
        schema[field] = { type: "url", url: {} };
        break;
      case "number":
        schema[field] = { type: "number", number: {} };
        break;
      case "date":
        schema[field] = { type: "date", date: {} };
        break;
      case "checkbox":
        schema[field] = { type: "checkbox", checkbox: {} };
        break;
      case "people":
        schema[field] = { type: "people", people: {} };
        break;
      case "relation":
        // Relation target DB id is injected at create-time by
        // create_jobs_db.js — here we emit a placeholder the caller overrides.
        schema[field] = { type: "relation", relation: { database_id: "__COMPANIES_DB__" } };
        break;
      case "select":
        schema[field] = {
          type: "select",
          select: { options: selectOptionsFor(field) },
        };
        break;
      case "status":
        // Notion's create API does not allow customizing status options
        // programmatically — they must be added via UI. We emit status
        // with an empty options block; caller documents the manual step.
        schema[field] = { type: "status", status: {} };
        break;
      default:
        throw new Error(`toNotionSchema: unknown type "${type}" for field "${field}"`);
    }
  }
  return schema;
}

// Default select options per field. Keeps the wizard "batteries-included"
// without requiring the user to pre-populate them in Notion UI.
function selectOptionsFor(field) {
  switch (field) {
    case "Source":
      return [
        { name: "greenhouse", color: "blue" },
        { name: "lever", color: "purple" },
        { name: "ashby", color: "pink" },
        { name: "smartrecruiters", color: "green" },
        { name: "workday", color: "orange" },
        { name: "remoteok", color: "gray" },
        { name: "calcareers", color: "yellow" },
        { name: "usajobs", color: "red" },
        { name: "manual", color: "default" },
        { name: "builtin", color: "brown" },
      ];
    case "Work Format":
      return [
        { name: "Remote", color: "green" },
        { name: "Hybrid", color: "yellow" },
        { name: "Onsite", color: "orange" },
        { name: "Any", color: "default" },
      ];
    case "Fit Score":
      return [
        { name: "Strong", color: "green" },
        { name: "Medium", color: "yellow" },
        { name: "Weak", color: "red" },
      ];
    case "Resume Version":
      return []; // populated at seed time from resume_versions.json
    default:
      return [];
  }
}

// Main entry: given intake.modules (+ flags), return propertyMap.
// `moduleFlags` param overrides gating for modules not normally in
// intake.modules (e.g. "prepare", "check" which are not discovery adapters
// but are core commands — always on for v1).
function resolvePropertyMap(intake = {}) {
  const result = { ...CORE_FIELDS };
  const modules = new Set(intake.modules || []);
  // prepare + check are core commands, always on.
  modules.add("prepare");
  modules.add("check");
  // watcher is gated by an explicit flag, not a module.
  if (intake.flags && intake.flags.watcher_enabled === true) {
    modules.add("watcher");
  }
  for (const [groupId, fields] of Object.entries(GATED_GROUPS)) {
    if (!modules.has(groupId)) continue;
    Object.assign(result, fields);
  }
  return result;
}

module.exports = {
  CORE_FIELDS,
  GATED_GROUPS,
  resolvePropertyMap,
  toNotionSchema,
  selectOptionsFor,
};
