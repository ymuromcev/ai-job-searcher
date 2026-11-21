# RFC 072 — AI vacancies first + LatAm RU-friendly channel

Status: approved 21.11.2026 (direction approved by owner 21.11.2026: «Да, и латам добавляем»; order «Порядок приоритета: 1. Мэтч 2. ИИ. Если в одном мэтч, а в другом мэтч и ИИ, выигрывает второй.»; salary bar «Давай от 80к»). Revised after the analyst cases (BL-243, round 1).
Tier: M · Backlog: BL-243 (AI first), BL-242 (LatAm)

## What the owner sees

1. **AI first within the same fit.** Order is fit (Strong → Medium → Weak), then AI
   before non-AI at the same fit. AI vacancies:
   AI PM / GenAI PM / agentic PM / PM at an AI-native company / internal AI roles
   (track `ai_roles`). The rest of the queue keeps today's order.
2. **LatAm.** Vacancies from companies in the RU-friendly LatAm pool (now Plata,
   Unlimit) stop being archived for Mexico / Colombia / LATAM locations and reach
   the bot. In the salary field the bot puts at least $80k (owner floor, 21.11).
   All other LatAm / non-US vacancies are still archived, as today.

Out of scope: new adapters (Praktika on Teamtailor), inDrive/Kodland/ID Finance
(no supported ATS), changes to fit scoring.

## Design

### A. AI-first ordering
- `engine/modules/apply/queue.js` sort key becomes
  `(FIT_RANK, isAi ? 0 : 1, newest)` — fit first, AI breaks ties
  (owner 21.11.2026: «1. Мэтч 2. ИИ»). The sort runs BEFORE the company cap and
  the `--limit`, so a company's AI rows take its cap slots first and `--limit N`
  pushes non-AI rows of the same fit out (`over_limit`, they stay To Apply).
  Both `buildQueue` callers use it: `apply --phase pre` (`apply.js`) and the
  night backlog count (`night.js`).
- `isAi(app)` (`engine/core/ai_priority.js`) is built from profile data
  `filter_rules.apply_priority`, not engine constants:
  - `ai_title_patterns` — regex sources, wrapped in word boundaries, case-insensitive
    (`AI`, `GenAI`, `Generative`, `LLM`, `Agentic`, `Machine Learning`). `AI` does
    not match `Sustainability`, `Thailand`, `OpenAI`; it does match `Ai PM`,
    `(AI)`, `AI/ML`, `AI-native`. A bad regex is reported through `warn` and skipped.
  - `ai_track_ids` — `role_targets` tracks (e.g. `ai_roles`) whose patterns also
    count, as literal phrases on word boundaries.
  - `ai_companies` — company names, exact match after `company_keys.normalizeName`;
    every role of such a company counts as AI.
  - Empty / null title is not AI. No `apply_priority` block means never AI, so the
    order is exactly today's (the rollback switch, and the state of the second profile).
- Strong non-AI goes before Medium AI; within the same fit AI goes first.
- Out of scope: `prepare` takes Inbox rows without regard to AI.

### B. LatAm channel exception
- `data/companies.tsv` already carries `extra_json.channel = "ru_latam"` (Plata,
  Unlimit). No column is added. `engine/core/company_channel.js` builds the index
  "normalized company name (plus the profile's `company_aliases`) → channel":
  exact match, never a prefix (`Unlimited Technologies` is not `Unlimit`;
  `Plata Card` has no channel unless the profile lists it as an alias). Broken or
  missing `extra_json` / `channel` costs only that row. The channel travels as the
  optional `job.channel` of `evaluateJob`.
- The exception lives in ONE place, `evaluate_job.js`, driven by
  `filter_rules.channel_exceptions[channel].allow_patterns` (matcher
  `company_channel.buildChannelAllow`: word boundaries, no case, no diacritics;
  `New Mexico` never counts):
  1. step 5 `location_blocklist`: when any location of the job matches an allow
     pattern the blocklist is not applied (mixed `["Mexico City", "Madrid"]` passes:
     one fitting place is enough);
  2. step 7 geo: `enforceGeo(..., { channelAllow })` returns `ok` with
     `matchedBy: "channel:ru_latam"` when a location (not in `geo.blocklist`)
     matches; the value is a trigger of the BL-225 JD workplace check
     (`needsJdWorkplaceCheck`), like `us_unspecified` and `remote:*` — the owner works
     from the US, so the check judges the JD of such a row: «Mexico City» with a
     remote JD, or a JD that says nothing about the format, passes; an explicit
     onsite / hybrid office is archived with the BL-225 reason `geo_jd_not_remote`
     (`prepare` JD pass, `jdWorkplaceVerdict(..., { officeAbroad: true })`: a channel
     row sits outside the home state, so the office does not have to be named in the
     JD; a named home-state office keeps the row, as for any row);
  3. step 6 salary: `getSalaryFloor(applyDefaults, channel)`.
- The channel is passed in the five places that judge a job: `filter.js` (scan,
  from `scan.js`), `prepare.js` (pass 1, the `geo_title_excluded` pre-check — a
  marker the channel allows, `(LATAM)` / `Remote - LATAM`, is not an exclusion,
  `(EMEA)` still is — pass 2, and the salary-floor pass), `validate.js` (the
  retro-sweep, so `validate --apply` does not archive To Apply Plata
  «Mexico City»), `queue.js` (the geo safety net, `apply.js` and `night.js` pass the
  index), and `apply.js` (desired salary). Companies without the channel and
  locations outside the allow list (Cyprus, London, Moscow, Belgrade, Yerevan …)
  are archived as today.
- Salary: `apply_defaults.salary.by_channel.ru_latam = { floor: 80000, default: 80000 }`
  (owner, 21.11.2026: from 80k). `salary.js normalizeConfig(cfg, channel)` overlays the
  channel's `floor` / `default` over the general ones; both `computeDesiredSalary`
  calls in `apply.js` and `applySalaryFloorPass` in `prepare.js` take the channel;
  `apply_defaults.js` validates `by_channel`. No published range: 80000. Range
  85–90k: kept (answer `90000` / `85000-90000`); 60–75k: `salary_below_floor`;
  120–150k: `150000`; 70–90k: `80000-90000`. Other companies keep the general floor
  95000. A range quoted in another currency or per month («$45,000 – $60,000 MXN
  mensuales», BRL / COP / ARS / CLP / PEN, `/month`) is not an annual USD range:
  both parsers (`published_salary.js` for prepare, `salary.js` for the bot, plus the
  JD «Compensation» section lookup) drop it, so the channel default applies. The
  figures of a dropped range are not re-read as single dollar amounts either, and a
  glued prefix (`MX$45,000`, `R$45,000`, `COP$…`) counts as a currency. A lone
  amount is judged by the rest of its sentence («Between $45,000 and $60,000 MXN per
  month» gives nothing), `USD monthly` / `USD per month` / `/month` are per month,
  an implausible range is dropped as a whole, and `$5 Million`, `$1.2 million`,
  `$150kUSD` keep their multiplier (only a glued currency code such as `MXN` is
  not a suffix). The salary
  numbers `floor` and `default` of a channel must be > 0 (the validator rejects 0).
- Form side («no surprise in pesos»): a salary field whose label names a currency
  (MXN / COP / BRL / ARS / CLP / PEN / UYU, «pesos») or a period («monthly»,
  «mensual», «per month», «al mes») is not answered with the annual-USD number.
  The owner's answer bank or standing answer still fills it; otherwise a required
  field skips the row (`apply_state = skipped`, `apply_note = no_honest_answer:
  foreign_currency_salary: <label>`, the bot never hands rows to a human, RFC 069)
  and an optional one stays empty. The owner sees the label among the questions
  and can answer it once. A bucketed select keeps going to the LLM step.

## Tests
- queue: Strong AI < Strong non-AI < Medium AI; non-AI order unchanged; `--limit`;
  company cap; the geo net with the channel.
- ai_priority: false friends, case and separators, companies, bad regex, no block.
- company_channel: name matching, aliases, exact-not-prefix, broken `extra_json`.
- evaluate_job / filter / scan / prepare / validate / apply / night: Plata
  «Mexico City» kept, the same location from a company without the channel still
  archived, mixed locations, accents, `(LATAM)` vs `(EMEA)`, non-LatAm places cut,
  `matchedBy channel:ru_latam`, salary floors and answers, MXN texts.
- All fixtures are in the tests: nothing depends on a working copy of a real profile.

## Rollback
Two files per profile, both optional blocks (copies `.pre-bl243-2026-11-21` sit
next to the owner's files):
- `profiles/<id>/filter_rules.json`: remove `apply_priority` (order goes back to
  fit + newest) and `channel_exceptions` (Plata / Unlimit locations are archived
  again).
- `profiles/<id>/apply_defaults.json`: remove `salary.by_channel` (the channel
  companies use the general floor and default again).
The engine reads nothing else; with both blocks gone the order, the geo rule and the
salary bar behave as before BL-243. Not covered by the switch, and for every company
and profile: a published range quoted in another currency (MXN / BRL / COP / ARS /
CLP / PEN / UYU) or per month is no longer read as annual USD (`salary_context.js`,
both parsers), and a salary field of the form named in another currency or per
period is never answered with our annual-USD number (the row is skipped as
`no_honest_answer`). To undo those, revert the BL-243 code, not the profile files.
