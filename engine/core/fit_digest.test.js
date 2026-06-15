"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildFitDigest, digestHash } = require("./fit_digest");

const STORIES = [
  {
    id: "S001",
    title: "Acme — checkout funnel (+18% CR)",
    primarySkill: "Funnel / experiments",
    secondarySkill: "Team leadership",
    commercialProfile: "B2C marketplace",
    earnedSecret: "Cycle speed beats hypothesis quality.",
    strength: "seed",
    deployFor: ["Funnel / growth", "team leadership"],
    result: "+18% end-to-end funnel CR.",
  },
  {
    id: "S002",
    title: "Acme — pricing rework (3x revenue)",
    primarySkill: "Pricing / monetization",
    secondarySkill: "Competitive analysis",
    commercialProfile: "TBD",
    earnedSecret: "Reference price is set by competitors.",
    strength: "confirmed",
    deployFor: ["Pricing", "monetization"],
    result: undefined,
  },
];

test("buildFitDigest: renders one block per story with skills/outcome/matches", () => {
  const md = buildFitDigest(STORIES, { profileId: "acme" });
  assert.match(md, /## S001 — Acme — checkout funnel \(\+18% CR\)/);
  assert.match(md, /- Skills: Funnel \/ experiments · Team leadership/);
  assert.match(md, /- Outcome: \+18% end-to-end funnel CR\./);
  assert.match(md, /- Matches: Funnel \/ growth, team leadership/);
});

test("buildFitDigest: omits Domain when TBD, omits Outcome when missing", () => {
  const md = buildFitDigest(STORIES, { profileId: "acme" });
  const s2 = md.slice(md.indexOf("## S002"));
  assert.doesNotMatch(s2, /- Domain:/); // S002 domain is TBD
  assert.doesNotMatch(s2, /- Outcome:/); // S002 has no result
  assert.match(md, /- Domain: B2C marketplace/); // S001 has a real domain
});

test("buildFitDigest: header carries profile id, hash and story count", () => {
  const md = buildFitDigest(STORIES, { profileId: "acme" });
  assert.match(md, /# Fit profile — real achievements \(acme\)/);
  assert.match(md, /<!-- stories: 2 -->/);
  assert.match(md, /<!-- fit-digest-hash: [0-9a-f]{12} -->/);
});

test("buildFitDigest: states all achievements count (no seed/confirmed gate)", () => {
  const md = buildFitDigest(STORIES, { profileId: "acme" });
  assert.match(md, /`seed` and `confirmed` alike/);
});

test("buildFitDigest: deterministic — same stories produce identical output", () => {
  assert.equal(
    buildFitDigest(STORIES, { profileId: "acme" }),
    buildFitDigest(STORIES, { profileId: "acme" })
  );
});

test("buildFitDigest: non-array input throws", () => {
  assert.throws(() => buildFitDigest(null), /must be an array/);
});

test("digestHash: stable for same content, changes when content changes", () => {
  const h1 = digestHash(STORIES);
  const h2 = digestHash(STORIES);
  assert.equal(h1, h2);

  const mutated = STORIES.map((s, i) => (i === 0 ? { ...s, result: "+25% CR." } : s));
  assert.notEqual(digestHash(mutated), h1);
});

test("digestHash: ignores fields not relevant to fit (useCount/lastUsed)", () => {
  const withCounts = STORIES.map((s) => ({ ...s, useCount: "9", lastUsed: "2026-06-15" }));
  assert.equal(digestHash(withCounts), digestHash(STORIES));
});
