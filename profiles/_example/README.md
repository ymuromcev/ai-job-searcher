# `_example/` profile — template

Copy this directory to `profiles/<your_id>/` and edit. `_example`
itself is read-only template content; don't run the CLI against
`--profile _example` (the profile-id validator will reject it anyway).

## Files

| File | What it is |
|---|---|
| `profile.example.json` | Identity, enabled modules, Notion DB ids, file references. Rename to `profile.json`. |
| `filter_rules.example.json` | Pre-Notion filters (company / title / location blocklists, company cap). Rename to `filter_rules.json`. |
| `resume_versions.example.json` | One master resume source; each `versions.<key>` is an archetype. Rename to `resume_versions.json`. |
| `cover_letter_template.example.md` | Skeleton with `{{placeholders}}`. Rename to `cover_letter_template.md`. |
| `cover_letter_versions.example.json` | One entry per cover-letter variant, keyed by `<company>_<role>_<focus>`. Rename to `cover_letter_versions.json`. |
| `memory/` | Voice + canonical-experience context files read by `prepare`. Copy and fill. |

## The fast path

Don't hand-edit. The [Stage 18 onboarding wizard](../../scripts/stage18/README.md)
takes a markdown intake form and generates all of the above plus
provisions per-profile Notion databases.

Hand-editing is fine for tinkering or for reading what the shapes
look like — but the wizard is the supported path.

## Required fields

After renaming the files, the following must be filled before
anything useful runs:

- `profile.json.id` — must match the directory name (e.g. `me`).
- `profile.json.identity.*` — name / phone / email / location / linkedin.
- `profile.json.notion.jobs_pipeline_db_id` — real Notion DB id
  (the wizard creates this for you).
- `profile.json.modules` — at least one discovery adapter.
- `resume_versions.json.contact` — mirrors `profile.json.identity`.
- `resume_versions.json.versions` — at least one archetype.

The example `property_map` is deliberately minimal (7 fields). Real
profiles usually have 20+ fields (salary, fit score, format, etc.)
— the wizard picks the right subset based on which features are on.

## What's gitignored

Everything under `profiles/<your_id>/` except `_example/` itself is
gitignored. Your resumes, cover letters, state files, applications
TSV — none of it leaves your machine.
