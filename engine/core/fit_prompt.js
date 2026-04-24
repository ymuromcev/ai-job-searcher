// Pure template renderer: builds a per-profile fit-evaluation prompt
// by substituting {{path.to.field}} placeholders from a { job, profile } context.
// No eval, no arbitrary code — only property access on the provided context.

function getPath(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function substitute(template, vars) {
  if (typeof template !== "string") throw new Error("template must be a string");
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key) => {
    const v = getPath(vars, key);
    return v == null ? "" : String(v);
  });
}

function buildFitPrompt({ job, profile }) {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile is required");
  }
  const template = profile.fit_prompt_template;
  if (typeof template !== "string" || template.length === 0) {
    throw new Error("profile.fit_prompt_template must be a non-empty string");
  }
  return substitute(template, { job: job || {}, profile });
}

module.exports = { buildFitPrompt, substitute };
