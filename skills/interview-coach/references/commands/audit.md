# audit — Round-File Audit Workflow

Invocation: `audit` (optionally `audit [company]`).

Mechanical check of the active round files. It replaces the coach's impression of readiness with a list of defects. Modelled on the grooming command in the `dev-workflow` skill: detectors, a report, then an offer to fix.

## When to run it

Cheap, so run it often:

- before any readiness claim — **mandatory**, this is the gate on the words «готов» and «100%»;
- between curriculum topics in `prep exam`;
- before a mock;
- at session start when an exam round is open.

Do **not** run it after every message. It is a checkpoint, not a heartbeat.

## How

```bash
node skills/interview-coach/scripts/round_audit.js profiles/<id>/interview-coach-state/rounds/
```

A single round file (with an optional explicit cheat-sheet path) also works:

```bash
node skills/interview-coach/scripts/round_audit.js <round-file.md> [cheat-sheet.md]
```

Exit code 0 means clean, 1 means findings. The cheat sheet is auto-paired by name (`<round-base>_ШПАРГАЛКА.md`).

## The detectors

| #   | Code                        | Fires when                                                                    |
| --- | --------------------------- | ----------------------------------------------------------------------------- |
| 1   | `missing-source`            | a curriculum topic has an empty «Источник» cell                               |
| 2   | `unstarted-when-ready`      | `status: ready` while a row is not `отработан вслух`                          |
| 3   | `open-debt`                 | a debt row has no `Закрыт` value                                              |
| 4   | `debt-id-gap`               | debt ids skip a number — a row was deleted                                    |
| 5   | `formula-without-derivation`| a cheat-sheet `Формула:` line lacks `Вытекает из:`                            |
| 6   | `spoken-line-missing`       | a cheat-sheet entry has no `🗣️ Если спросят:` line                            |
| 7   | `topic-not-in-cheatsheet`   | a curriculum row number has no matching `## N.M` cheat-sheet section          |
| 8   | `forbidden-section`         | a section not allowed for this `kind` is present                              |
| 9   | `write-after-freeze`        | the round file was modified inside the T−4h window                            |
| 10  | `topic-not-in-any-case` / `no-cases` | a curriculum row no case apex reaches — or, at `status: ready`, no `## Кейсы` section at all |
| 11  | `case-node-without-source`  | an unroll node states an answer with no `[тема N]`, no `[K<n>]` and no `мой синтез` |
| 12  | `apex-names-machinery`      | a case apex names the apparatus instead of a decision — a step posing as a case |
| 13  | `trigger-missing`           | a cheat-sheet entry has a definition but no `Триггер:` situation line          |

`мой синтез` in the source cell satisfies detector 1 on purpose — it is an honest declaration of lower reliability, not a gap.

Detector 10 counts coverage **across all case levels at once**. A topic whose applied meaning exists only at the big apex (multiple comparisons, peeking) is covered by being referenced there; do not invent a fake small case to satisfy a per-level count. Its two allowed fixes are extending a case or marking the row `служебное` — never dropping the row. A `служебное` row is exempt from detectors 7 and 10 both: a topic with no standalone applied meaning is taught inside its parent's descent and has no standalone cheat-sheet entry either.

## Reporting

Show the report as-is, then say plainly what it means for readiness. Do not soften it, do not summarize thirteen findings as "почти всё готово".

If findings exist, fix what is fixable without asking (write the missing `Вытекает из:`, add the missing spoken line, reopen a deleted debt) and re-run. Ask only about things that need the candidate — a topic that still has to be drilled out loud cannot be fixed by the coach alone.

When the report is clean, say so and hand the readiness verdict to the candidate: the coach shows the table, the candidate decides whether they are ready.

## The debrief loop audit (RFC 066)

The same idea on the other side of the interview: a mechanical check that the debrief loop is closed, not the coach's impression that it was. Run it after writing or closing an `## Outcome` block, and at session start when an interview is coming up.

```bash
node skills/interview-coach/scripts/debrief_audit.js profiles/<id>/interview-coach-state/coaching_state.md
```

A profiles directory also works — it audits every profile's `coaching_state.md`:

```bash
node skills/interview-coach/scripts/debrief_audit.js profiles/
```

Exit code 0 means clean, 1 means findings. Every check is silent while `Result: pending` — an open outcome owes nothing until its gate resolves.

| #   | Code                        | Fires when                                                                     |
| --- | --------------------------- | ------------------------------------------------------------------------------ |
| 1   | `outcome-without-channel`   | a resolved `## Outcome` block has no `LIVE`/`PAPER` channel                     |
| 2   | `outcome-unreconciled`      | a resolved outcome has an empty `Reconciliation` (prediction never checked)     |
| 3   | `condition-not-quarantined` | a loss under adverse `Conditions` is not `Baseline: quarantined`               |
| 4   | `root-cause-missing-status` | a Cross-Dimension Root Cause row has no `active`/`improving`/`watching`/`closed`/`resolved` status |

The block shape these detectors read is defined in `debrief.md` → "Outcome Block". Fix what is fixable without asking (tag the channel from the transcript, quarantine an obvious no-sleep run, set a missing status) and re-run; ask the candidate only where the answer is theirs (which channel actually decided, whether a run was genuinely condition-driven).

## Limits

- The audit reads files. It cannot tell whether a topic marked `отработан вслух` was genuinely answered out loud — that invariant is the coach's, and its failure mode is documented in `prep-exam.md` § "Core invariant".
- Rounds of kind `screening` and `manager` have no curriculum table, so detectors 1, 2, 7, 10–13 are naturally silent for them; detectors 3, 4, 8 and 9 still apply.
- Detector 13 runs at audit time, not at write time. The `Формула:` rule is checkable on a single line in isolation, so the write guard enforces it; a missing `Триггер:` is only visible against the whole entry, and blocking a partial edit that is about to add the next line would be a false positive.
