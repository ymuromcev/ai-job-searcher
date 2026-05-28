# RFC 050 — Per-profile answer style enforcement

- **BL**: BL-138
- **Status**: draft → approved 2026-05-27 (user said "делай все")
- **Author**: Jared
- **Tier**: M

## Problem

`/job-pipeline answer` generates application Q&A. Five formatting rules
exist for jared (see `profiles/jared/memory/feedback_answer_formatting.md`),
and violation = recruiter screen-out flag. Memory-file delivery is
unreliable: the LLM forgets across sessions, especially after
compaction. Per global CLAUDE.md: "Memory читается LLM'ом и регулярно
подводит — это ненадёжный канал для «делать каждый раз». Hooks
выполняет harness — они срабатывают детерминистически, до Claude."

## Solution — two layers

| Rule | Layer | Reason |
|---|---|---|
| `~123` → `about 123` | CLI sanitizer | Deterministic regex, no judgment |
| em dash `—` → ` - ` (hyphen with spaces) | CLI sanitizer | Deterministic |
| `60x`, `10x` → `60 times`, `10 times` | CLI sanitizer | Deterministic |
| `we/our/us` → `I/my/me` (candidate's own work) | SKILL prose | Context-dependent; needs LLM judgment |
| `passport` → `government ID` (KYC illustrative fields) | SKILL prose | Context-dependent |

**Layer A — CLI sanitizer**: `engine/modules/answer/style_sanitizer.js`
exports pure `sanitize(answer, ruleNames) → { sanitized, changes[] }`.
Three rules implemented:

- `tilde_to_about`: `/~(?=\d)/g` → `about ` (only when followed by digit;
  preserves `~/.bashrc`, `~user`, etc.).
- `em_dash_to_hyphen`: `/—/g` → ` - ` then collapse runs of spaces.
- `x_multiplier_to_times`: `/(\d+(?:\.\d+)?)x\b(?!\.\w)/g` → `$1 times`
  (only digit-prefixed; preserves variable names like `box`, URLs).

`engine/commands/answer.js` push phase applies sanitizer to `answer`
field **before** writing to Notion and local backup, only if
`profile.answer.style_sanitizer.enabled === true`. Diff logged to
stderr.

**Layer B — SKILL prose**: `~/.claude/skills/job-pipeline/SKILL.md`
`### answer` Step 5 (generation) gains a new bullet that reads
`profile.answer.style_guidance` (if present) and applies it before
producing the draft. Guidance text travels with the profile, not
memory.

## Profile config schema

`profiles/jared/profile.json` gains:

```json
"answer": {
  "style_sanitizer": {
    "enabled": true,
    "rules": ["tilde_to_about", "em_dash_to_hyphen", "x_multiplier_to_times"]
  },
  "style_guidance": "Pronoun discipline: when describing your own work use I/my/me, not we/our/us. Use we only when the team's collective action matters (e.g. 'the team shipped X'). KYC illustrative fields: prefer 'government ID' over 'passport' for US/Western audiences."
}
```

Default for other profiles: omit the block (sanitizer disabled,
guidance not applied). Lilia opts in explicitly if she wants the same
rules.

## Edge cases

- `~/.bashrc`, `~user` — sanitizer ignores (lookahead requires digit).
- URLs with `x` (e.g. `2x.example.com`) — `\b(?!\.\w)` lookahead skips.
- `60x60` matrix notation — first `60x` becomes `60 times`, leaving
  `60 times60` (acceptable; matrix language extremely rare in
  application answers). Rule documented as known limitation.
- Empty `answer` string — sanitizer no-ops, returns input unchanged.
- Already-sanitized answer (regenerated) — idempotent; second pass
  yields zero changes.

## Backward compatibility

- Existing profiles without the `answer` block: sanitizer disabled by
  default, no behavior change.
- `profiles/jared/memory/feedback_answer_formatting.md`: stays on disk
  with `DEPRECATED 2026-05-27` header pointing to this RFC. Removed in
  a follow-up cleanup BL once confirmed sanitizer + SKILL prose carry
  the load.

## Tests

`engine/modules/answer/style_sanitizer.test.js`:

- Each of three rules: positive case + negative case (false-positive
  guard).
- Idempotency: `sanitize(sanitize(x)) === sanitize(x)`.
- Empty input.
- All-rules-enabled vs subset.
- `changes[]` array reports diffs accurately.

`engine/commands/answer.test.js` gains:

- Push phase calls sanitizer when `style_sanitizer.enabled === true`.
- Push phase skips sanitizer when disabled / block missing.
- Sanitizer error doesn't block Notion push (logged, original answer
  used).

## DoD (mirrors BL-138)

1. `engine/modules/answer/style_sanitizer.js` + tests (≥8 cases).
2. `engine/commands/answer.js` push phase wires sanitizer.
3. `~/.claude/skills/job-pipeline/SKILL.md` Step 5 reads
   `profile.answer.style_guidance`.
4. `profiles/jared/profile.json` gets `answer` block (manual user step
   if PM-Claude doesn't touch personal profiles; PR description
   includes the JSON snippet).
5. `profiles/jared/memory/feedback_answer_formatting.md` gets
   DEPRECATED header.
6. CHANGELOG entry.
7. PR + smoke + BL-138 closed.

## Out of scope

- New rules beyond the five existing.
- Changes to answer generation (length, tone) — only post-processing
  + prompt guidance.
- Lilia profile changes — explicit opt-in later if desired.
