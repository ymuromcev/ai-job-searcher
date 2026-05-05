# Add a new pipeline step

Extend the engine's pipeline with a new gating or transformation step.
Use this runbook when the new step affects every profile (a
cross-cutting concern), not when one profile needs a one-off filter
adjustment — those go in the profile's `filter_rules.json`.

## 1. When to add a step

Add a pipeline step when:

- The concern applies to every profile (geo enforcement, fit
  pre-rank, salary calibration).
- The transformation is pure data-in / data-out and does not belong
  inside an adapter.
- A maintainer needs to gate, score, or annotate jobs at a well-defined
  point in the existing flow.

If the concern is profile-specific, prefer extending
`filter_rules.json` or `profile.json` over adding a global step.

## 2. Pick a slot

The pipeline runs in this order. Insert at the boundary that makes
the step composable with what is already there:

```
discovery
  -> filter (blocklists, location guards)
  -> dedup (URL canon, company+title fallback)
  -> TSV append
  -> pre-rank (fit prerank, optional)
  -> prepare (URL+JD+fit+salary+CL+geo)
  -> sync (Notion push)
  -> check (Gmail responses)
```

Add steps before `prepare` for jobs you want to silently drop or
score. Add inside `prepare` for steps that need fit scoring or JD text.
Add after `sync` for steps that need a Notion page id.

## 3. Implement as a pure module

Pure module under `engine/core/<step>.js`. `engine/core/filter.js` is
the canonical reference: a default-export factory plus named pure
helpers, no I/O, no side effects. Surface every input and decision as
a return value so the orchestrator stays in command code.

```js
// engine/core/myshape.js
function applyMyshape(rows, rules) {
  return rows
    .map((r) => annotate(r, rules))
    .filter((r) => r.passes);
}

module.exports = { applyMyshape };
```

If the step needs network or disk, wrap that in `engine/commands/` and
keep `engine/core/` pure.

## 4. Wire into the relevant command

Edit the command file under `engine/commands/<command>.js` to call the
new step. Add a CLI flag if the step is opt-in or has a phase split
(`--phase pre|commit`, `--no-myshape`). The flag declarations live in
`engine/cli.js`'s `PARSE_OPTIONS`.

For an opt-in step, default to off and document the flag in the
`HELP_TEXT` block. For a default-on step, document the disable flag
and a rationale for when to use it.

## 5. Tests

Two layers, both required:

```bash
# Unit: pure-module behavior across edge cases.
node --test engine/core/myshape.test.js

# Smoke: command-level run with the step engaged, fakes for I/O.
node --test engine/commands/<command>.test.js
```

The pre-commit hook runs `npm test`. Anything red blocks the commit.

## 6. Document

Three updates:

- `docs/architecture/overview.md` — extend the data-flow map to
  show the new step in its slot.
- `docs/reference/cli.md` — if the step adds or changes any flag.
- `CHANGELOG.md` — under the next unreleased section, summarize the
  step in one line plus a link to its RFC.

If the step changes any TSV column, also update
`docs/reference/tsv-schema.md` and bump the schema version.

## 7. Tier check

Most pipeline steps are Tier M (multi-file feature, behavioral
change). Tier M requires an RFC under `rfc/NNN-title.md` and explicit
maintainer approval before code lands. See `DEVELOPMENT.md` for the
full tier table and the RFC template. If the step touches security,
secrets, or migration semantics, it is Tier L — `/security-review` and
`/review` are required in addition to the RFC.

## See also

- [Architecture overview](../architecture/overview.md)
- [CLI reference](../reference/cli.md)
- [RFC 015 — fit pre-rank](../../rfc/015-fit-prerank.md)
