---
name: relokant-sweep
description: "Repeatable sourcing sweep for the relokant sweet-zone channel — CIS-rooted companies whose product+engineering team is still Russian-speaking, selling into US/EU, mid-size, not globalized (gold standard Virto Commerce, anti-pattern Miro). One run: pull a fresh batch of candidates from not-yet-swept sources, classify by sweet-zone + US-viability, dedup against both ledgers on code, append new sweet-zone to ru_friendly_targets.tsv and rejects to ru_friendly_rejects.tsv, and draft outreach for each new US-viable target. Trigger on: /relokant-sweep, or when the user asks to source / sweep / find more relokant / CIS-rooted / ru-friendly companies for a profile."
---

# relokant-sweep — CIS-rooted company sourcing sweep

Repeatable, **manual-launch** sourcing for the "relokant sweet zone"
channel (BL-200 / RFC 061). The engine's scan adapters are deliberately
out of scope — this is LLM-driven web research + judgement, not a
deterministic fetch. You run it; you keep the human in the loop on the
cheap stage (candidate review) before any outreach.

**Default profile: `jared`.** All file paths below are under
`profiles/<id>/`. Run from the repo root.

---

## What one run produces

1. New sweet-zone companies appended to `profiles/<id>/ru_friendly_targets.tsv`.
2. Rejected companies appended to `profiles/<id>/ru_friendly_rejects.tsv`
   with a reason (memory of the sweep — next run won't re-research them).
3. An outreach draft for each **new US-viable** target (contact +
   message). **Drafts only — the user sends them by hand.**
4. A short run report + an updated source-rotation log.

---

## Classification — the sweet zone

A company **passes** only if ALL four hold:

1. Founded in CIS / post-Soviet.
2. Product + engineering team still predominantly Russian-speaking
   (hubs: Yerevan, Tbilisi, Belgrade, Limassol/Cyprus, Warsaw, Lisbon,
   Almaty, Tashkent).
3. Sells into US/EU (western comp band, remote-friendly).
4. Mid-size, NOT globalized (US-HQ + English-internal + "we hire anyone"
   = drops out).

Two rejection modes (record in rejects with the reason):

- **`too_globalized`** — Miro, Wrike, Preply, People.ai, Ecwid/Lightspeed.
  Already American, the ru-signal is dead.
- **`wrong_market`** — Russian-speaking team but sells into CIS/LatAm/SEA,
  i.e. non-western comp band (inDrive, ID Finance, Skyeng, Refocus,
  YouTravel, Mate academy). UA-companies are excluded from targeting
  (user decision 2026-06-22) — record them here too.

**US-viability is a SOFT signal, not a hard filter.** The question is not
"does this company post a US-remote product role" but "would it make an
EXCEPTION the way Virto did": the company has a US client → on-the-ground
US management is valuable + the candidate is already in the US (no
relocation) + green card (no visa friction). The mechanism is outreach to
the founder / Head of Product, not an ATS apply. Flag the level in the
`us_viability` column (HIGH / exception / WEAK / unverified) — never drop
a company just because it has no public US-remote posting.

---

## Run steps

### 1. Load the ledgers

Read both TSVs into a known-names set so you never re-surface a company.
This is on code, not on your memory:

```
node scripts/relokant/sweep_dedup.js --profile <id> "Name A" "Name B" ...
```

It prints `FRESH\t<name>` or `DUP\t<name>` per input. You pass candidate
names here in step 4 before appending. (`ru_friendly_rejects.tsv` may not
exist on the very first run — the helper treats a missing file as empty.)

### 2. Pick the next source batch

Rotate through sources so a run covers new ground instead of re-opening
relokant trackers every time. **Read the rotation log first:**

```
profiles/<id>/.relokant-state/sources_log.md
```

It records which sources each past run covered and the date. Pick the
2–3 sources that are stalest (or never touched). Source pool:

- relocant trackers / "relocation" startup lists;
- VC portfolios with CIS roots (Runa Capital, Begin Capital,
  ex-Yandex / JetBrains / Wrike spinouts);
- Crunchbase filter: founder-education CIS + HQ US/EU;
- communities (RAIN, RusBase, Telegram tech channels, Yerevan / Tbilisi /
  Belgrade tech hubs);
- LinkedIn founder-search (CIS-educated founders, US/EU HQ);
- Habr company blogs of teams going global.

Do the actual research with `firecrawl_search` / `web_search_exa`. Keep
queries specific (founder name + city + "product", VC + "portfolio", etc.).

### 3. Classify each candidate

For every company you surface, apply the 4 sweet-zone criteria and assign
a US-viability level. Capture: website, ru_signal (founder + city),
market, us_viability, candidate contact (founder / Head of Product),
open_roles_url, ATS slug if any, notes.

### 4. Dedup

Collect all candidate names and pass them through the helper (step 1).
Drop everything marked `DUP` silently — those are already in targets or
rejects. Only `FRESH` names proceed.

### 5. Append

- **Sweet-zone (FRESH)** → append a row to `ru_friendly_targets.tsv`.
  Match the existing 10-column schema exactly (header in the file):
  `name`, `website`, `ru_signal`, `market`, `us_viability`, `channel`,
  `ats`, `contact`, `open_roles_url`, `notes`. Tab-separated. Set
  `us_viability` to the level you judged.
- **Rejects (FRESH)** → append a row to `ru_friendly_rejects.tsv`:
  `name`, `reason` (`too_globalized` / `wrong_market` / `other`),
  `note`, `date`. Tab-separated.

Never write a `DUP` to either file. Never edit existing rows — append only.

### 6. Outreach drafts (new US-viable only)

For each new target with US-viability HIGH or "exception", produce:

- the best contact (founder or Head of Product, with a source for the name);
- a short outreach draft in the same style as the existing top-3 drafts
  (see `profiles/<id>/outbound-strategy.md` if present). Neutral, specific
  to the company's US client wedge — not a generic "I'm looking for work".

**You draft; the user sends.** Do not auto-send anything.

### 7. Update the rotation log + report

Append a dated entry to `profiles/<id>/.relokant-state/sources_log.md`:
which sources you swept, how many candidates seen, how many new targets /
rejects / dupes. Then report to the user in chat:

> Swept N candidates from <sources>. K new sweet-zone (→ targets), M
> rejected (→ rejects), D dupes filtered. New US-viable: <names>.

---

## Cadence

Run manually every 2–4 weeks. If you later want it automated, you can
layer `/schedule` on top of this skill (a routine that invokes
`/relokant-sweep`) — the skill mechanics don't change. Auto-cron is not
part of RFC 061.

---

## Hard rules

- **Append only.** Never rewrite or delete existing TSV rows.
- **Dedup on code.** Always run names through `sweep_dedup.js` before
  appending — do not rely on remembering what's already there.
- **Drafts only for outreach.** The user sends messages by hand.
- **No engine changes.** If a sweep needs the scan engine / a new
  discovery adapter, stop and open an RFC — that's out of scope here.
- **PII stays in profiles/.** These TSVs are gitignored personal data;
  never echo a real contact's details into a committed file.
