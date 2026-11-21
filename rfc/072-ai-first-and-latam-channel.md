# RFC 072 — AI vacancies first + LatAm RU-friendly channel

Status: approved 21.11.2026 (direction approved by owner 21.11.2026: «Да, и латам добавляем»)
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
  (owner 21.11.2026: «1. Мэтч 2. ИИ»).
- `isAi(app)` = title matches the `ai_roles` track patterns OR an AI title
  regex (`\bAI\b|GenAI|Generative|LLM|Agentic|Machine Learning`) that
  lives in `filter_rules.json` → `apply_priority.ai_title_patterns`
  (profile data, not engine constants).
- Strong non-AI goes before Medium AI; within the same fit AI goes first.

### B. LatAm channel exception
- `data/companies.tsv` already carries `extra_json.channel = "ru_latam"`.
- Scan: `filter.js` skips `location_blocklist` patterns listed in
  `filter_rules.json` → `channel_exceptions.ru_latam.allow_patterns`
  (Mexico, Colombia, LATAM, Latin America, Brazil, Argentina, Chile, Peru,
  Remote LATAM) only for jobs whose company has `channel=ru_latam`.
- Apply: `geo_enforcer` gets the same exception via a `channel` hint on
  the row, so the queue does not archive the job a second time.
- Salary: `apply_defaults.salary.floor_by_channel.ru_latam = 80000`;
  the bot fills ≥ $80k for those rows instead of the US floor.

## Tests
- queue: Strong AI < Strong non-AI < Medium AI; non-AI order unchanged.
- filter: Plata job in "Mexico City" kept; same location from a company
  without the channel still archived.
- geo_enforcer: channel hint bypasses only the allow-listed patterns.
- salary: ru_latam row gets 80000.

## Rollback
Remove `apply_priority` / `channel_exceptions` blocks from filter_rules.json —
engine falls back to today's behaviour.
