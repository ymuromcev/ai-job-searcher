// generators/cover_letter.js — intake.cover_letter → template.md + versions.json
//
// Produces two artifacts:
//   1. cover_letter_template.md — markdown shell with {{placeholders}} the
//      humanizer / prepare pipeline fills per-job.
//   2. cover_letter_versions.json — per-archetype overrides (keyed by
//      resume archetype slug). Empty by default; user edits later.

function lengthHint(length) {
  switch ((length || "").toLowerCase()) {
    case "short":
      return "Keep under 200 words. One punchy hook, one proof, one ask.";
    case "long":
      return "Can run 400+ words if the match is strong. Multi-paragraph.";
    case "medium":
    default:
      return "Target 200–400 words. Intro + why interested + why fit + close.";
  }
}

function toneHint(tone) {
  switch ((tone || "").toLowerCase()) {
    case "formal":
      return "Formal register. Third-person impersonal is OK. No contractions.";
    case "punchy":
      return "Direct. Short sentences. Lead with a result.";
    case "conversational":
    default:
      return "Conversational. First person. Contractions OK. Sound like a human.";
  }
}

function buildCoverLetterTemplate(intake = {}) {
  const cl = intake.cover_letter || {};
  const identity = intake.identity || {};
  const name = (identity.full_name || "").trim() || "{{FULL_NAME}}";
  const signature = (cl.signature && cl.signature.trim()) || `Best,\n${name}`;

  const intro = cl.intro_hint || "Open with why this company matters to me.";
  const whyInterested = cl.why_interested_hint || "Reference something specific about the company.";
  const whyFit = cl.why_fit_hint || "Tie my last shipped thing to their roadmap.";
  const close = cl.close_hint || "Propose a short conversation.";

  return [
    `<!-- Cover letter template for ${name}.`,
    `     Voice: ${toneHint(cl.tone)}`,
    `     Length: ${lengthHint(cl.length)}`,
    `     Hiring managers don't want a form letter. prepare fills {{placeholders}} per job. -->`,
    ``,
    `Dear Hiring Manager,`,
    ``,
    `{{INTRO_PARAGRAPH}}`,
    `<!-- Hint: ${intro} -->`,
    ``,
    `{{WHY_INTERESTED_PARAGRAPH}}`,
    `<!-- Hint: ${whyInterested} -->`,
    ``,
    `{{WHY_FIT_PARAGRAPH}}`,
    `<!-- Hint: ${whyFit} -->`,
    ``,
    `{{CLOSE_PARAGRAPH}}`,
    `<!-- Hint: ${close} -->`,
    ``,
    signature,
    ``,
  ].join("\n");
}

function buildCoverLetterVersions(intake = {}) {
  // Starts as a skeleton keyed by archetype slug. The prepare skill fills
  // job-specific overrides at runtime; user may also pre-populate per-archetype
  // defaults.
  const versions = {};
  const archetypes = Array.isArray(intake.resume_archetypes) ? intake.resume_archetypes : [];
  for (const a of archetypes) {
    if (!a || !a.key) continue;
    versions[a.key] = {
      // Empty overrides by default — prepare + template produce the final text.
      // Present keys so user can see where to add per-archetype tweaks.
      intro_override: "",
      why_interested_override: "",
      why_fit_override: "",
      close_override: "",
    };
  }
  return { versions };
}

module.exports = {
  buildCoverLetterTemplate,
  buildCoverLetterVersions,
  lengthHint,
  toneHint,
};
