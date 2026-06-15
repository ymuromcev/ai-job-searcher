"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseStorybank } = require("./storybank");

// Synthetic fixture — mirrors the real coaching_state.md storybank shape
// (table + `### Story Details` with RU/EN STAR blocks) but contains no PII.
const FIXTURE = `# Coaching State

## Profile

Some preamble.

## Storybank
| ID   | Title                                  | Primary Skill        | Secondary Skill   | Commercial Profile | Earned Secret (RU draft, awaiting candidate review) | Strength  | Use Count | Last Used |
|------|----------------------------------------|----------------------|-------------------|--------------------|-----------------------------------------------------|-----------|-----------|-----------|
| S001 | Acme — checkout funnel (+18% CR)       | Funnel / experiments | Team leadership    | B2C marketplace    | Cycle speed beats hypothesis quality.               | seed      | 0         | —         |
| S002 | Acme — pricing rework (3x revenue)     | Pricing / monetization | Competitive analysis | B2C startup     | Low price signals low quality, not access.          | confirmed | 2         | 2026-06-01 |

### Story Details

#### S001 — Acme: checkout funnel (+18% CR)

| 🇷🇺 Russian | 🇬🇧 English |
|------------|------------|
| **Situation.** Воронка низкая. | **Situation.** The funnel CR was low. |
| **Task.** Поднять конверсию. | **Task.** Lift end-to-end CR. |
| **Action.** 30+ A/B. | **Action.** Ran 30+ A/B tests. |
| **Result.** +18% CR. | **Result.** **+18% end-to-end funnel CR.** |
| **Earned Secret.** Скорость цикла. | **Earned Secret.** **Cycle speed beats hypothesis quality.** |

- **Deploy for.** Funnel / growth / experimentation, team leadership, execution at scale.
- **Версионирование.** 2026-06-01 — v1.

#### S002 — Acme: pricing rework (3x revenue)

| 🇷🇺 Russian | 🇬🇧 English |
|------------|------------|
| **Situation.** Цена ниже рынка. | **Situation.** Price was below market. |
| **Result.** Выручка 3x. | **Result.** **3x revenue in one quarter.** |
| **Earned Secret.** Reference price. | **Earned Secret.** **Reference price is set by competitors.** |

- **Deploy for.** Pricing, monetization, competitive strategy.

## Score History

Trailing section that must NOT be parsed as storybank.
| ID | Title | Primary Skill | Secondary Skill | Commercial Profile | Earned Secret | Strength |
| X1 | should-be-ignored | a | b | c | d | seed |
`;

test("parseStorybank: returns one record per table row, in order", () => {
  const stories = parseStorybank(FIXTURE);
  assert.equal(stories.length, 2);
  assert.deepEqual(
    stories.map((s) => s.id),
    ["S001", "S002"]
  );
});

test("parseStorybank: maps columns by header name", () => {
  const [s1] = parseStorybank(FIXTURE);
  assert.equal(s1.id, "S001");
  assert.equal(s1.title, "Acme — checkout funnel (+18% CR)");
  assert.equal(s1.primarySkill, "Funnel / experiments");
  assert.equal(s1.secondarySkill, "Team leadership");
  assert.equal(s1.commercialProfile, "B2C marketplace");
  assert.equal(s1.earnedSecret, "Cycle speed beats hypothesis quality.");
  assert.equal(s1.strength, "seed");
});

test("parseStorybank: strength is normalized to lowercase", () => {
  const stories = parseStorybank(FIXTURE);
  assert.equal(stories[0].strength, "seed");
  assert.equal(stories[1].strength, "confirmed");
});

test("parseStorybank: enriches with Result (English cell) from detail block", () => {
  const stories = parseStorybank(FIXTURE);
  assert.equal(stories[0].result, "+18% end-to-end funnel CR.");
  assert.equal(stories[1].result, "3x revenue in one quarter.");
});

test("parseStorybank: enriches with Deploy-for tags", () => {
  const [s1, s2] = parseStorybank(FIXTURE);
  assert.deepEqual(s1.deployFor, [
    "Funnel / growth / experimentation",
    "team leadership",
    "execution at scale",
  ]);
  assert.deepEqual(s2.deployFor, ["Pricing", "monetization", "competitive strategy"]);
});

test("parseStorybank: does not bleed into the next ## section", () => {
  const stories = parseStorybank(FIXTURE);
  assert.ok(!stories.some((s) => s.id === "X1"));
});

test("parseStorybank: missing detail block yields empty deployFor and undefined result", () => {
  const md = `## Storybank
| ID | Title | Primary Skill | Secondary Skill | Commercial Profile | Earned Secret | Strength |
|----|-------|---------------|------------------|--------------------|----------------|----------|
| S001 | Bare row | Skill A | Skill B | B2C | Secret. | seed |

## Next
`;
  const [s] = parseStorybank(md);
  assert.deepEqual(s.deployFor, []);
  assert.equal(s.result, undefined);
});

test("parseStorybank: no storybank section returns empty array", () => {
  assert.deepEqual(parseStorybank("# Doc\n\n## Other\ntext"), []);
});

test("parseStorybank: non-string input throws", () => {
  assert.throws(() => parseStorybank(null), /must be a string/);
});
