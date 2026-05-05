---
id: RFC-007
title: Industries as relations between Companies and Profiles
status: superseded
tier: L
created: 2026-04-30
decided: 2026-04-30
superseded-by: RFC-008
tags: [companies, industries, schema]
---

# RFC 007 — Industries as relations between Companies and Profiles

**Status**: Superseded by [RFC 008](./008-companies-as-notion-source-of-truth.md) on 2026-04-30
**Tier**: L (data migration, refactor of scan/check/prepare/sync, testing across 2+ profiles)
**Author**: Claude + PM-Pete
**Depends on**: [RFC 006 — email-check per-profile companies](./006-email-check-per-profile-companies.md) (must be run and stable)

## Problem

The current companies-per-profile architecture does not scale:

- The global `data/companies.tsv` is de facto specialized for PM-Pete (250 fintech).
- Healthcare-Hannah's companies (75 healthcare) live inside her `profile.json.discovery.companies_whitelist` — this is a config, not a DB.
- Adding a third profile (e.g. HR/recruiter, design lead) requires either bloating the whitelist in profile.json or adding their companies into the shared companies.tsv (where they'll be mixed with fintech).
- `profile.json.target_industries` already has industry tags, but they are not used anywhere for filtering.

Each command (`scan`, `check`, `prepare`, `sync`) currently has to decide manually "which companies for which profile" — this produces branching logic and a risk of drift between commands.

## Target architecture

```
data/companies.tsv:
  name | ats_source | ats_slug | industries | extra_json
  Affirm           | greenhouse | affirm        | fintech, lending, credit |
  Stripe           | greenhouse | stripe        | fintech, payments        |
  Kaiser Permanente| indeed     | kaiser-sac    | healthcare, hospitals    |
  Cameron Park Dental Office | manual | -       | healthcare, dental       |
  ...

profile.json:
  target_industries: ["fintech", "banking", "credit", "lending"]   # PM-Pete
  target_industries: ["healthcare", "dental", "vision", "hospitals"] # Healthcare-Hannah

single function in engine/core/companies.js:
  function companiesForProfile(profile, allCompanies) {
    const targetSet = new Set(profile.target_industries.map(i => i.toLowerCase()));
    return allCompanies.filter(c => 
      (c.industries || []).some(i => targetSet.has(i.toLowerCase()))
    );
  }
```

All commands use `companiesForProfile()` — no per-profile branches.

## Key tasks

1. **Industry taxonomy** — produce a tag dictionary (≤30 items): `fintech`, `banking`, `credit`, `lending`, `payments`, `crypto`, `insurance`, `wealth_mgmt`, `healthcare`, `dental`, `vision`, `hospitals`, `dermatology`, `physical_therapy`, etc. Store it in `data/industries.json` with a description for each.

2. **Migration of `data/companies.tsv`**:
   - Add an `industries` column (comma-separated).
   - LLM-classify the existing 250 fintech companies → set tags.
   - Import 75 of Healthcare-Hannah's healthcare companies from her whitelist into `companies.tsv` with tags.
   - Remove `companies_whitelist` from her `profile.json` (or keep it as an override).

3. **Code refactor**:
   - `engine/core/companies.js` — add `companiesForProfile(profile, allCompanies)`.
   - `engine/commands/scan.js` — switch from `applyTargetFilters(whitelist/blacklist)` to `companiesForProfile`.
   - `engine/commands/check.js` — switch `buildCompanySet` (RFC 006) to `companiesForProfile`.
   - Keep `companies_whitelist` as an opt-in override (if set — takes priority).
   - `companies_blacklist` — keep as an exclusion filter on top of industry-match.

4. **Testing**:
   - Regression for PM-Pete: scan/check return the same or a larger company set than they do now.
   - Regression for Healthcare-Hannah: scan/check return her 75 healthcare companies with no losses.
   - New profile (synthetic) — add via a single target_industries line, verify nothing breaks.

5. **Backfill industries for applications.tsv** (optional): assign industry tags to historical companyName entries in applications.tsv for later analytics ("how many responses per industry").

## Related changes

- LLM classifier for industries (one-off script): takes name + ats_source + URL → returns an array of industries from the taxonomy.
- Migration of `applications.tsv` (optional): not required for check/scan functionality, but enables analytics.
- Docs: README about industry-tags and how to add new ones.

## Risks

- **LLM classification can be wrong** on edge cases (Capital One = banking? credit? both?). Manual review by the user after the first run is needed.
- **Conflicting tags**: a company may fit several industries. Solution — array, ANY-match.
- **What to do with companies without industries** (not yet tagged) — fall back to whitelist override or the current companies_whitelist mechanism.
- **Breaking change for other commands** that use `applyTargetFilters`. A careful migration in a single PR is needed.

## Open questions (require user input before the full RFC version)

1. Industry taxonomy — fixed list or free-form? If fixed — how detailed (3-level hierarchy or flat)?
2. Behavior if a company has no industries — include in `companiesForProfile` output (warn) or hide (silent)?
3. Migration of Healthcare-Hannah's companies — all 75 into `companies.tsv` or only those that have already drawn her attention (via applications.tsv)?
4. `target_industries` in profile.json — exact match or hierarchical (`fintech` matches `fintech.lending`)?
5. When do we plan it — after stable email-check (RFC 006) or in parallel?

## Acceptance criteria (draft)

- [ ] All commands (`scan`, `check`, `prepare`, `sync`) use a single `companiesForProfile()`.
- [ ] Branches "if jared X else Y" removed across the entire engine.
- [ ] Regression: no company losses for PM-Pete vs current behavior.
- [ ] Regression: no company losses for Healthcare-Hannah vs current behavior.
- [ ] New profile (synthetic test) — added via a single config line.
- [ ] LLM classification has been run + the result reviewed by the user.
- [ ] README about industry-tags updated.

---

**Status**: Stub. Before the RFC is fully ready, the following is required:
1. User answers to the open questions above.
2. User decision on timeline (after RFC 006 / in parallel / postpone).

Until it is brought to Approved — implementation is blocked.
