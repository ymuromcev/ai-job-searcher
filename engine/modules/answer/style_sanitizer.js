// Per-profile answer style sanitizer.
//
// Pure helper: applies a set of opt-in regex-based style rules to an answer
// string before it is pushed to Notion / written to the local backup.
//
// Per RFC 050 — Per-profile answer style enforcement.
//
// Each rule is deterministic and narrowly scoped to avoid false positives:
//
// - `tilde_to_about`         : `~123` → `about 123` (lookahead requires a
//                              digit; preserves `~/.bashrc`, `~user`, etc.)
// - `em_dash_to_hyphen`      : `—` → ` - ` (hyphen with surrounding spaces),
//                              then collapse runs of spaces to a single space.
// - `x_multiplier_to_times`  : `60x`, `10x`, `2.5x` → `60 times` / `2.5 times`
//                              (digit-prefixed only; `\b(?!\.\w)` lookahead
//                              skips URL-like fragments such as
//                              `2x.example.com` and ignores variable names
//                              like `box`).
//
// All rules are idempotent: running `sanitize(sanitize(x))` yields the same
// output as `sanitize(x)`.
//
// Unknown rule names are silently ignored (forward-compatibility with future
// rules added to profile.json). Callers that want strict validation should
// check `ruleNames` against `KNOWN_RULES` before invoking.

const KNOWN_RULES = ["tilde_to_about", "em_dash_to_hyphen", "x_multiplier_to_times"];

// --- individual rule implementations ----------------------------------------
//
// Each returns `{ next, changes }`:
//   - `next`    : string after applying the rule
//   - `changes` : array of `{ rule, before, after }` describing each match.
//
// `before` / `after` capture only the matched fragment + replacement, not the
// full string — that keeps the change log compact when an answer has many
// matches.

function applyTildeToAbout(input) {
  const changes = [];
  const re = /~(?=\d)/g;
  const next = input.replace(re, () => {
    changes.push({ rule: "tilde_to_about", before: "~", after: "about " });
    return "about ";
  });
  return { next, changes };
}

function applyEmDashToHyphen(input) {
  const changes = [];
  // Step 1: replace em dash with ` - ` (with surrounding spaces).
  let next = input.replace(/—/g, () => {
    changes.push({ rule: "em_dash_to_hyphen", before: "—", after: " - " });
    return " - ";
  });
  // Step 2: collapse runs of spaces to a single space. We deliberately do not
  // touch newlines or other whitespace classes — only the literal space (' ')
  // character, since the previous step is the only thing that can introduce
  // adjacent spaces.
  if (changes.length > 0) {
    next = next.replace(/ {2,}/g, " ");
  }
  return { next, changes };
}

function applyXMultiplierToTimes(input) {
  const changes = [];
  // `\b(?!\.\w)` — match a word boundary that is NOT followed by `.<word-char>`,
  // which would indicate a URL host fragment like `2x.example.com`. The
  // digit prefix (`\d+(?:\.\d+)?`) keeps the rule from firing on identifier
  // tokens like `box`, `tex`, `regex`, etc.
  const re = /(\d+(?:\.\d+)?)x\b(?!\.\w)/g;
  const next = input.replace(re, (match, num) => {
    const after = `${num} times`;
    changes.push({ rule: "x_multiplier_to_times", before: match, after });
    return after;
  });
  return { next, changes };
}

const RULE_IMPL = {
  tilde_to_about: applyTildeToAbout,
  em_dash_to_hyphen: applyEmDashToHyphen,
  x_multiplier_to_times: applyXMultiplierToTimes,
};

// --- public API --------------------------------------------------------------

/**
 * Apply a set of style rules to `answer`.
 *
 * @param {string} answer    The raw answer text from the SKILL.
 * @param {string[]} ruleNames Opt-in list of rule identifiers (see KNOWN_RULES).
 *   Rules are applied in the order they appear in `ruleNames`. Unknown names
 *   are silently ignored.
 * @returns {{ sanitized: string, changes: Array<{rule:string, before:string, after:string}> }}
 */
function sanitize(answer, ruleNames) {
  // Defensive: non-string input returns as-is with an empty change log. The
  // caller is responsible for validating the draft shape (see
  // `engine/commands/answer.js#validateDraft`); this function just makes sure
  // it never throws on bad input.
  if (typeof answer !== "string" || answer.length === 0) {
    return { sanitized: typeof answer === "string" ? answer : "", changes: [] };
  }
  if (!Array.isArray(ruleNames) || ruleNames.length === 0) {
    return { sanitized: answer, changes: [] };
  }

  let current = answer;
  const allChanges = [];
  for (const name of ruleNames) {
    const impl = RULE_IMPL[name];
    if (!impl) continue;
    const { next, changes } = impl(current);
    current = next;
    if (changes.length > 0) allChanges.push(...changes);
  }
  return { sanitized: current, changes: allChanges };
}

module.exports = { sanitize, KNOWN_RULES };
