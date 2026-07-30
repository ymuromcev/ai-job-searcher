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

`мой синтез` in the source cell satisfies detector 1 on purpose — it is an honest declaration of lower reliability, not a gap.

## Reporting

Show the report as-is, then say plainly what it means for readiness. Do not soften it, do not summarize nine findings as "почти всё готово".

If findings exist, fix what is fixable without asking (write the missing `Вытекает из:`, add the missing spoken line, reopen a deleted debt) and re-run. Ask only about things that need the candidate — a topic that still has to be drilled out loud cannot be fixed by the coach alone.

When the report is clean, say so and hand the readiness verdict to the candidate: the coach shows the table, the candidate decides whether they are ready.

## Limits

- The audit reads files. It cannot tell whether a topic marked `отработан вслух` was genuinely answered out loud — that invariant is the coach's, and its failure mode is documented in `prep-exam.md` § "Core invariant".
- Rounds of kind `screening` and `manager` have no curriculum table, so detectors 1, 2 and 7 are naturally silent for them; detectors 3, 4, 8 and 9 still apply.
