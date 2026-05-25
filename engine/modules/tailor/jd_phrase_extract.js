// LLM-driven JD-phrase extraction for the Strong-fit tailoring loop (RFC 044).
//
// The Strong-fit `resume-tailor-mirror` subagent uses this helper to convert a
// raw JD (+ the deterministic structure from `engine/core/jd_extract.js`) into
// a list of "significant" phrases the tailored resume must mirror lexically.
//
// Per RFC 044 Open Question #6/#7, this is **LLM-only** — there is no heuristic
// fallback. To keep the module pure and testable we accept the LLM callable as
// a dependency (`llmCallFn`) and ship a pure prompt-builder we can unit-test.
//
// Output shape: `[{ phrase, category, priority }]` where
//   category ∈ {requirement, responsibility, domain, skill, tech, soft_skill}
//   priority ∈ {high, medium, low}
//
// In production `llmCallFn` is wired by the orchestrator (or directly by the
// subagent) to the Anthropic SDK; in tests we inject a fake that returns a
// fixture. The wrapper handles two response shapes for ergonomics:
//   1. Already-parsed array (test fixtures).
//   2. A string containing a JSON array (LLM raw text response) — we extract
//      the first balanced `[ ... ]` block and JSON.parse it.
//
// Exports:
//   extractJDPhrases({jdText, jdStructure, llmCallFn}) → Promise<phrase[]>
//   buildPhrasePrompt(jdText, jdStructure)             → string  (pure)
//   parsePhrasesFromLLM(raw)                           → phrase[]  (pure)

const ALLOWED_CATEGORIES = new Set([
  "requirement",
  "responsibility",
  "domain",
  "skill",
  "tech",
  "soft_skill",
]);
const ALLOWED_PRIORITIES = new Set(["high", "medium", "low"]);

const PROMPT_HEADER = `You extract "significant phrases" from a job description for a lexical-mirror
resume-tailoring loop (RFC 044). The goal: every phrase you return MUST appear
verbatim (or near-verbatim) in the tailored resume so the candidate clears
keyword-matching ATS filters.

Return ONLY a JSON array (no prose, no fences). Each element:
  { "phrase": "...", "category": "...", "priority": "..." }

Rules:
- category ∈ {requirement, responsibility, domain, skill, tech, soft_skill}
- priority ∈ {high, medium, low}
- Use the JD's own wording. Do NOT paraphrase.
- 20–40 phrases for a typical JD. Prefer multi-word phrases over single tokens.
- "high" priority: stated as required, listed in must-have, or repeated.
- "medium": nice-to-have, secondary responsibilities, listed once.
- "low": tangential context (e.g., company-blurb domain hints).
- Do NOT include generic filler ("communication skills" with no qualifier) unless
  the JD specifically calls it out.`;

/**
 * Build the LLM prompt as a pure string from the raw JD + the deterministic
 * structure already extracted upstream. We include both because the structure
 * is bullet-level (high signal but normalised) and the raw text catches phrases
 * embedded in prose (company blurb, sub-clauses).
 *
 * @param {string} jdText — raw JD body
 * @param {object} jdStructure — output of extractJDStructure() (may be {} / null)
 * @returns {string}
 */
function buildPhrasePrompt(jdText, jdStructure) {
  const struct = jdStructure && typeof jdStructure === "object" ? jdStructure : {};
  const requirements = Array.isArray(struct.requirements) ? struct.requirements : [];
  const responsibilities = Array.isArray(struct.responsibilities)
    ? struct.responsibilities
    : [];

  const sections = [
    PROMPT_HEADER,
    "",
    "## Pre-extracted requirements",
    requirements.length ? requirements.map((r) => `- ${r}`).join("\n") : "(none)",
    "",
    "## Pre-extracted responsibilities",
    responsibilities.length
      ? responsibilities.map((r) => `- ${r}`).join("\n")
      : "(none)",
    "",
    "## Raw JD text",
    String(jdText || "").trim() || "(empty)",
    "",
    "Return the JSON array now.",
  ];
  return sections.join("\n");
}

/**
 * Parse the LLM response into a normalised phrase array. Accepts either an
 * already-parsed array or a raw string. Filters out entries with invalid
 * category/priority (logged-silently dropped) and normalises whitespace.
 *
 * @param {unknown} raw
 * @returns {Array<{phrase: string, category: string, priority: string}>}
 */
function parsePhrasesFromLLM(raw) {
  let arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    arr = extractJsonArray(raw);
  } else if (raw && typeof raw === "object" && Array.isArray(raw.phrases)) {
    // Lenient: subagent might wrap as { phrases: [...] }.
    arr = raw.phrases;
  }
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const phrase = String(item.phrase || "").replace(/\s+/g, " ").trim();
    const category = String(item.category || "").toLowerCase();
    const priority = String(item.priority || "").toLowerCase();
    if (!phrase) continue;
    if (!ALLOWED_CATEGORIES.has(category)) continue;
    if (!ALLOWED_PRIORITIES.has(priority)) continue;
    out.push({ phrase, category, priority });
  }
  return out;
}

/**
 * Extract the first balanced JSON array substring from `text` and parse it.
 * Tolerates code-fence wrappers (```json ... ```) and leading/trailing prose.
 * Returns null on failure (caller treats as no phrases).
 *
 * @param {string} text
 * @returns {Array|null}
 */
function extractJsonArray(text) {
  if (!text) return null;
  let s = String(text);
  // Strip fenced code blocks.
  s = s.replace(/```(?:json)?\n?/gi, "").replace(/```/g, "");
  const start = s.indexOf("[");
  if (start < 0) return null;
  // Walk to find the matching ].
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        const block = s.slice(start, i + 1);
        try {
          const parsed = JSON.parse(block);
          return Array.isArray(parsed) ? parsed : null;
        } catch (_e) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Run the LLM extraction. `llmCallFn` is an async dependency: it receives the
 * prompt string and returns either an array of phrases (test fixture) or a
 * raw text response (production).
 *
 * @param {object} args
 * @param {string} args.jdText
 * @param {object} args.jdStructure
 * @param {(prompt: string) => Promise<unknown>} args.llmCallFn
 * @returns {Promise<Array<{phrase: string, category: string, priority: string}>>}
 */
async function extractJDPhrases({ jdText, jdStructure, llmCallFn }) {
  if (typeof llmCallFn !== "function") {
    throw new Error("extractJDPhrases: llmCallFn is required");
  }
  const prompt = buildPhrasePrompt(jdText, jdStructure);
  const raw = await llmCallFn(prompt);
  return parsePhrasesFromLLM(raw);
}

module.exports = {
  extractJDPhrases,
  buildPhrasePrompt,
  parsePhrasesFromLLM,
  ALLOWED_CATEGORIES,
  ALLOWED_PRIORITIES,
};
