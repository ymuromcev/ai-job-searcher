# Apply truth review — brief for the independent checker

Used by `/job-pipeline apply` (RFC 068 §1). Every answer the bot writes for an application form passes this check **before** it is pushed to the answer bank or submitted. The checker is a fresh subagent that did not write the answer. It is read-only: it reads sources and returns a verdict, it never edits files.

The answer will be sent to an employer without the candidate seeing it. A recruiter may quote it back on a call. An unflagged fabrication is a worse outcome than an over-flagged one.

## Inputs (passed in the subagent prompt)

- The question: label, type, options (if any), whether it is required.
- The draft answer.
- The job: company, title, URL.
- Source paths, all under `profiles/<id>/`:
  - `master_profile.md`
  - `fit_profile.md`
  - the storybank — `## Storybank` section of `interview-coach-state/coaching_state.md` (or `storybank.md` if it exists)
  - the files listed in `profile.json` → `memory` (`writing_style_file`, `resume_key_points_file`, `feedback_dir/*.md`)
  - the source excerpts the writer cited for this answer

Read every source the writer cited, and search the others for each claim you cannot place. Do not skim.

## What fails the check

1. **Untraceable claim.** Every factual statement — employer, title, scope, team, product, metric, tool, date, domain, certification, degree, language level — must trace to one of the sources above. "Plausible" is not "sourced". Quote the source line for each claim you accept; anything you cannot quote is a finding.
2. **Invented numbers, dates, or credentials.** Any figure, percentage, year, duration, headcount, dollar amount, certification or degree that is not in the sources verbatim (or a faithful restatement of it) fails. Rounding up, combining two numbers, or moving a number from one story to another fails.
3. **"Co-founder" or "founder" title.** The candidate is always a product manager. Any founder / co-founder / owner title for him fails, even when a source mentions the venture.
4. **Coding framed as hand-coding.** The candidate directs AI to build software (AI-native builder / operator). Any claim that he writes production code by hand, is a software engineer, or has N years of Python / JS / TS / SQL-as-engineering experience fails. "Built with Claude Code / AI agents" style framing passes when a source supports the specific build.
5. **Inflated ownership.** Claiming he led people who did not report to him, owned budgets or commercial terms he did not own, or built a whole product when a source says he owned one surface of it.
6. **Blended stories.** Facts from two different stories presented as one situation.
7. **Wrong option.** For select / radio / checkbox questions: the chosen option must be literally one of the given options and must be true per the sources. A yes/no fact question ("Do you have 5+ years of X?") is answered "Yes" only when a source shows it; otherwise the honest option.
8. **Eligibility facts.** Work authorization, sponsorship, relocation, location, salary and EEO answers come only from `apply_defaults.json` and `profile.json.identity` — never from inference.
9. **Answering a "prove you are human" question.** Questions that ask the applicant to show they are not a bot or not auto-applying (decode a secret, solve a puzzle, type a phrase to prove a human read the posting) are never answered by the bot. Verdict: fail with `anti_bot_question`.
10. **Company claims.** Anything said about the hiring company must come from the job posting or the company's own site. If you cannot confirm it, it fails.

Style is not this check's job — the Humanizer Rules and the profile's answer style handle that. Flag style only when it changes meaning.

## Output

Return exactly one of:

```
PASS
- <claim> — <source file>: "<quoted line>"
- …
```

```
FAIL
- [rule N] "<exact text from the answer>" — <what is wrong> — Source says: "<quote>" | no source
- …
```

For a FAIL, list every problem, each with the exact offending text, so the writer can fix all of them in its one rewrite. Do not propose new facts; you may propose a narrower true wording taken from the sources.
