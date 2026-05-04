# Development principles

**This is the canonical place for architecture and development principles.**
Not CLAUDE.md (that file is for AI assistant behaviour rules only).

---

## Code-first principle

AI is used only where it genuinely adds value. Everything deterministic
must be implemented in engine code — not delegated to a skill or prompt.

**Use AI for:**
- Fit scoring and geo validation (requires judgment)
- Cover letter generation (requires natural language)
- Email classification (requires understanding context)

**Do NOT use AI for:**
- Pipeline steps that always run in sequence (e.g. scan → sync)
- Data transformations with known input/output shapes
- Filtering by rules expressible as code
- Any step where the output is fully determined by the input

Rule of thumb: if a user without Claude could run the feature by
following a fixed script, it belongs in the engine. If it requires
understanding or creativity, it belongs in the skill.

This ensures the pipeline works for users who don't use Claude at all.

---

## Adding a new pipeline step

If two commands should always run in sequence and neither step requires AI,
wire them as a `PIPELINE_HOOKS` entry in `engine/cli.js` — not in the skill.
See the `scan → sync` hook as the canonical example.
