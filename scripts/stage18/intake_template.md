# Onboarding Intake — AIJobSearcher

Fill each field under its heading. Answers can be in **English or Russian** —
field keys stay English, values are free-form text.

**Skip optional fields** by leaving the value empty or writing `(skip)`.
**List fields** (starting with `items:` or a bullet prefix) accept multiple
entries, one per line starting with `-`.

When done, paste this entire filled file into chat — I'll parse it and
produce `.stage18/intake.json`.

**Do NOT paste secrets here.** Section I only captures which env vars you've
set; the actual token values live in `.env` and I never read them.

---

## A. Identity

- profile_id: <!-- e.g. profile_b; lowercase, a-z 0-9 _ only, must start with a letter -->
- full_name:
- email:
- phone:
- location_city:
- location_state: <!-- two-letter US state or region; empty for non-US -->
- location_country: <!-- e.g. US, UA, DE -->
- linkedin: <!-- URL or linkedin.com/in/... handle -->
- personal_site: <!-- optional -->
- pronouns: <!-- optional: she/her, he/him, they/them -->

## B. Career context

- current_role: <!-- e.g. Senior Product Manager at Acme -->
- years_experience: <!-- a number, e.g. 8 -->
- level: <!-- one of: IC, Senior IC, Staff, Principal, Manager, Director -->
- seniority: <!-- one of: junior, mid, senior, staff, principal -->
- target_roles:
  - <!-- e.g. Product Manager -->
  - <!-- e.g. Senior PM -->
- title_blocklist:
  - <!-- titles you never apply for, e.g. Director, VP, Intern -->

## C. Preferences

- work_format: <!-- one of: remote, hybrid, onsite, any -->
- locations_ok: <!-- cities/states you'd work in; one per line -->
  - <!-- e.g. Sacramento, CA -->
  - <!-- e.g. Remote (US) -->
- location_blocklist:
  - <!-- cities/states that are a hard no -->
- salary_min_total_comp: <!-- number, in USD; e.g. 180000 -->
- salary_ideal_total_comp: <!-- number, in USD -->
- salary_currency: <!-- default USD -->
- industries_prefer:
  - <!-- e.g. Fintech, AI, Healthcare -->
- industries_avoid:
  - <!-- e.g. Defense, Gambling -->
- company_sizes_ok: <!-- any of: Startup, Scaleup, Mid, Enterprise; comma-separated -->

## D. Target companies

- tier_s: <!-- dream companies; one per line -->
  - <!-- e.g. Stripe -->
- tier_a: <!-- strong interest -->
  - <!-- e.g. Ramp -->
- tier_b: <!-- open -->
  - <!-- e.g. Sardine -->
- tier_c: <!-- backup -->
  - <!-- e.g. Tala -->
- company_blocklist:
  - <!-- companies you won't apply to; one per line -->

## E. Resume archetypes

For each resume variant you want to maintain, add a sub-section `### E.N <key>`
where `<key>` is a short slug like `ai-pm` or `fintech`. Repeat E.1, E.2, ...
for each archetype. One archetype minimum.

### E.1 <key>
- title: <!-- display title, e.g. AI Product Manager -->
- summary: <!-- 1–2 sentences for the resume header -->
- bullets: <!-- 3–5 highlighted bullets -->
  -
  -
- tags: <!-- comma-separated keywords for matching, e.g. ai, ml, platform -->

<!-- Add more: ### E.2 <key>, ### E.3 <key>, ... -->

## F. Cover letter voice

- signature: <!-- e.g. Best, Jared -->
- tone: <!-- one of: formal, conversational, punchy -->
- length: <!-- one of: short (<200w), medium (200–400w), long (400+w) -->
- intro_hint: <!-- 1 sentence — how you like to open -->
- why_interested_hint: <!-- 1 sentence -->
- why_fit_hint: <!-- 1 sentence -->
- close_hint: <!-- 1 sentence -->

## G. Notion

- parent_page_url: <!-- URL of an empty page in your Notion workspace -->
- integration_name: <!-- name of the Notion integration you installed, e.g. "AIJobSearcher" -->
- integration_shared: <!-- yes/no — did you share parent_page_url with the integration? -->

## H. Discovery modules

Tick which adapters to enable. Defaults (what Jared uses): greenhouse, lever,
ashby, smartrecruiters, workday. Leave a line commented out to disable.

- modules:
  - discovery:greenhouse
  - discovery:lever
  - discovery:ashby
  - discovery:smartrecruiters
  - discovery:workday
  - discovery:remoteok
  # - discovery:calcareers   # US state/CA gov jobs; requires no extra key
  # - discovery:usajobs      # US federal jobs; requires USAJOBS_API_KEY+EMAIL

## I. Required .env variables

Confirm you've set these in the root `.env` of your `ai-job-searcher/` clone (do not paste values here):

- env_notion_token_set: <!-- yes/no. Variable: <PROFILE_ID_UPPER>_NOTION_TOKEN -->
- env_usajobs_set: <!-- yes/no — only required if usajobs is in modules. Variables: <PROFILE_ID_UPPER>_USAJOBS_API_KEY + _USAJOBS_EMAIL -->

## J. Prototype import (optional)

Skip this section if you don't have an existing local prototype project.

- has_prototype: <!-- yes/no -->
- prototype_path: <!-- absolute path, e.g. /Users/me/.../Profile B Job Search -->
- import_cover_letter_template: <!-- yes/no -->
- import_resume_versions: <!-- yes/no -->
- import_cover_letter_versions: <!-- yes/no — copies cover_letter_config.json if present -->
- import_generated_cover_letters: <!-- yes/no — copies cover_letters/ directory -->
- import_generated_resumes: <!-- yes/no — copies resumes/ directory -->
- import_tsv: <!-- yes/no — copies job_registry.tsv (only if prototype has one) -->
- import_notion_workspace_url: <!-- URL — if set, snapshots prototype Notion Jobs DB; leave empty to skip -->

## K. Optional flags

- watcher_enabled: <!-- yes/no; adds Notion "Watcher" person field. Default: no -->
- include_companies_seed: <!-- yes/no — auto-seed tier_s/a/b/c companies into Companies DB on deploy. Default: yes -->
