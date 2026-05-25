// Smoke + unit tests for scripts/build_master_profile.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  main,
  renderMaster,
  dedupeBullets,
  buildSkillsInventory,
  normalizeForDedupe,
  segmentsToMarkdown,
  segmentsToText,
  computeVisibility,
  computeSourceHash,
  applyClusters,
  renderCluster,
} = require("./build_master_profile.js");

// ---------- fixtures ----------

const fixtureRv = {
  contact: {
    name: "Test Candidate",
    email: "test@example.com",
    phone: "+1 555 000 0000",
    location: "Testville, CA",
    linkedin: "linkedin.com/in/test",
  },
  shared_roles: {
    credit_mentor: {
      role: "AI Product Advisor",
      company: "Credit Mentor",
      location: "LA",
      dates: "Jun 2025–Present",
      description: "Credit-building app.",
    },
    alfa: {
      role: "Senior PM",
      company: "Alfa-Bank",
      location: "Moscow",
      dates: "Mar 2022–Apr 2025",
      description: "Big bank.",
    },
    ferma: { role: "PM", company: "Ferma", dates: "2019–2021" },
    smmacc: { role: "PM", company: "SMMACC", dates: "2016–2019" },
    croc: { role: "Junior PM", company: "CROC", dates: "2015" },
  },
  shared_experience: {
    ferma: [
      { text: "Built ", bold: false },
      { text: "26× MRR growth", bold: true },
      { text: " in 2020.", bold: false },
    ],
    smmacc: [
      { text: "Led website + SEO with ", bold: false },
      { text: "$25k→$1M transaction limit", bold: true },
      { text: ".", bold: false },
    ],
    croc: [{ text: "Ran market research.", bold: false }],
  },
  shared_projects: [
    { name: "Test Project", dates: "2024", url: "github.com/test", description: "A thing." },
  ],
  shared_sections: {
    education: [{ degree: "B.A.", school: "Test University", dates: "2015–2019" }],
    skillsFixed: [
      { label: "AI Tools", value: "Claude | ChatGPT" },
      { label: "Tools", value: "Figma | Notion" },
    ],
  },
  certifications: [
    { name: "MCP Intro", issuer: "Anthropic", displayDate: "Apr 2026", archetypes: null },
  ],
  versions: {
    ArchA: {
      title: "PM — ARCHETYPE A",
      summary: "Summary A.",
      creditMentor: [{ text: "Intro paragraph A.", bold: false }],
      creditMentorBullets: [
        [
          { text: "Shipped feature X driving ", bold: false },
          { text: "30% conversion lift", bold: true },
          { text: ".", bold: false },
        ],
        [{ text: "Built only-in-A bullet.", bold: false }],
      ],
      alfaBullets: [[{ text: "Doubled partner traffic.", bold: false }]],
      skillsProduct: ["A/B Testing", "Funnel Optimization"],
      skillsDomain: ["FinTech"],
      filename: "test_a.docx",
    },
    ArchB: {
      title: "PM — ARCHETYPE B",
      summary: "Summary B.",
      creditMentor: [{ text: "Intro paragraph B.", bold: false }],
      creditMentorBullets: [
        [
          { text: "Shipped feature X driving ", bold: false },
          { text: "30% conversion lift", bold: true },
          { text: ".", bold: false },
        ], // same as ArchA — should dedupe
      ],
      alfaBullets: [[{ text: "Doubled partner traffic.", bold: false }]],
      skillsProduct: ["A/B Testing", "Customer Interviews"],
      skillsDomain: ["FinTech", "Payments"],
      filename: "test_b.docx",
    },
  },
};

// ---------- pure helper tests ----------

test("segmentsToText joins text segments", () => {
  assert.equal(segmentsToText([{ text: "a" }, { text: "b" }]), "ab");
  assert.equal(segmentsToText(null), "");
});

test("segmentsToMarkdown wraps bold segments", () => {
  assert.equal(
    segmentsToMarkdown([
      { text: "a ", bold: false },
      { text: "B", bold: true },
      { text: " c", bold: false },
    ]),
    "a **B** c"
  );
});

test("normalizeForDedupe strips punctuation and case", () => {
  assert.equal(normalizeForDedupe("Shipped Feature X — 30% lift!"), "shipped feature x - 30% lift");
});

test("dedupeBullets merges identical bullets across archetypes with used_in tags", () => {
  const result = dedupeBullets(fixtureRv.versions, (v) => v.creditMentorBullets || []);
  // 3 unique bullets: shipped-feature-X (in both), only-in-A (1 archetype)
  // Note: intro paragraphs are NOT pulled by this getter
  const shipped = result.find((b) => b.plain.includes("Shipped feature X"));
  assert.ok(shipped, "shipped-feature bullet present");
  assert.deepEqual(shipped.used_in.sort(), ["ArchA", "ArchB"]);

  const onlyA = result.find((b) => b.plain.includes("only-in-A"));
  assert.ok(onlyA, "only-in-A bullet present");
  assert.deepEqual(onlyA.used_in, ["ArchA"]);
});

test("buildSkillsInventory unions across archetypes + skillsFixed", () => {
  const inv = buildSkillsInventory(fixtureRv);
  const aiTools = inv.find((b) => b.label === "AI Tools");
  assert.deepEqual(aiTools.skills, ["ChatGPT", "Claude"]);
  const product = inv.find((b) => b.label.startsWith("Product"));
  assert.deepEqual(product.skills.sort(), [
    "A/B Testing",
    "Customer Interviews",
    "Funnel Optimization",
  ]);
  const domain = inv.find((b) => b.label.startsWith("Domain"));
  assert.deepEqual(domain.skills.sort(), ["FinTech", "Payments"]);
});

test("computeVisibility marks always when role spans >= threshold archetypes", () => {
  assert.deepEqual(computeVisibility(["A", "B"], 2, 2), { visibility: "always", variants: null });
  assert.deepEqual(computeVisibility(["A"], 2, 2), {
    visibility: "variant-specific",
    variants: ["A"],
  });
  assert.deepEqual(computeVisibility([], 2, 2), { visibility: "always", variants: null });
});

// ---------- render tests ----------

test("renderMaster includes all required top-level sections", () => {
  const md = renderMaster(fixtureRv, "testprofile", {
    generatedAt: "2026-05-24",
    sourceHash: "deadbeef",
  });
  for (const section of [
    "## Contact",
    "## Career Narrative",
    "## Visibility Schema",
    "## Roles",
    "## Personal Projects",
    "## Education",
    "## Certifications",
    "## Skills Inventory",
    "## Languages",
    "## STAR Stories",
    "## Notes",
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }
  assert.ok(md.includes("source_hash: deadbeef"));
  assert.ok(md.includes("generated_at: 2026-05-24"));
});

test("renderMaster tags all-coverage bullets with used_in: [all]", () => {
  const md = renderMaster(fixtureRv, "testprofile", { generatedAt: "2026-05-24", sourceHash: "x" });
  // The shipped-feature-X bullet is in both archetypes → "all"
  assert.ok(
    /Shipped feature X[\s\S]*used_in: \[all\]/m.test(md),
    "shipped feature should be tagged [all]"
  );
});

test("renderMaster includes coaching_state.md reference for STAR Stories", () => {
  const md = renderMaster(fixtureRv, "testprofile");
  assert.ok(md.includes("profiles/testprofile/interview-coach-state/coaching_state.md"));
});

// ---------- integration test: main() against fixture on disk ----------

test("main() writes master_profile.md and is idempotent", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bmp-"));
  const profileDir = path.join(tmpRoot, "profiles", "testprof");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "resume_versions.json"),
    JSON.stringify(fixtureRv, null, 2)
  );

  const exit1 = main(["--profile", "testprof", "--root", tmpRoot], { generatedAt: "2026-05-24" });
  assert.equal(exit1, 0);
  const out1 = fs.readFileSync(path.join(profileDir, "master_profile.md"), "utf8");

  // Run again
  const exit2 = main(["--profile", "testprof", "--root", tmpRoot], { generatedAt: "2026-05-24" });
  assert.equal(exit2, 0);
  const out2 = fs.readFileSync(path.join(profileDir, "master_profile.md"), "utf8");

  assert.equal(out1, out2, "second run should produce byte-identical output");

  // Sanity: output starts with frontmatter
  assert.ok(out1.startsWith("---\nprofile_id: testprof"));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("main() exits 1 when profile is missing", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bmp-"));
  const origErr = console.error;
  console.error = () => {}; // silence
  try {
    const exit = main(["--profile", "nonexistent", "--root", tmpRoot]);
    assert.equal(exit, 1);
  } finally {
    console.error = origErr;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("main() exits 1 when --profile is omitted", () => {
  const origErr = console.error;
  console.error = () => {};
  try {
    const exit = main([]);
    assert.equal(exit, 1);
  } finally {
    console.error = origErr;
  }
});

test("computeSourceHash is deterministic", () => {
  const h1 = computeSourceHash('{"a":1}');
  const h2 = computeSourceHash('{"a":1}');
  assert.equal(h1, h2);
  assert.notEqual(h1, computeSourceHash('{"a":2}'));
});

// ---------- clustering tests ----------

test("applyClusters routes bullets by match_patterns; first-match wins", () => {
  const bullets = [
    {
      canonical: "Rebuilt partner API.",
      plain: "Rebuilt partner API.",
      used_in: ["ArchA"],
      alternates: [],
    },
    {
      canonical: "Launched MFI integration for $500K.",
      plain: "Launched MFI integration for $500K.",
      used_in: ["ArchB"],
      alternates: [],
    },
    {
      canonical: "Unrelated bullet.",
      plain: "Unrelated bullet.",
      used_in: ["ArchA"],
      alternates: [],
    },
  ];
  const clusterDefs = [
    { id: "api", name: "API", canonical: "...", match_patterns: ["partner api"] },
    { id: "mfi", name: "MFI", canonical: "...", match_patterns: ["$500k", "mfi"] },
  ];
  const { clustered, unmatched } = applyClusters(bullets, clusterDefs, ["ArchA", "ArchB"]);
  assert.equal(clustered.length, 2);
  assert.equal(clustered[0].def.id, "api");
  assert.equal(clustered[0].angles.length, 1);
  assert.equal(clustered[1].def.id, "mfi");
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].plain, "Unrelated bullet.");
});

test("renderCluster emits canonical + outcome + sorted angles", () => {
  const c = {
    def: {
      id: "x",
      name: "Test Cluster",
      canonical: "Canonical statement.",
      outcome: "Key metric.",
    },
    angles: [
      { md: "Short angle.", used_in: ["ArchA"] },
      { md: "Wide angle.", used_in: ["ArchA", "ArchB", "ArchC"] },
    ],
  };
  const md = renderCluster(c, ["ArchA", "ArchB", "ArchC"]);
  assert.ok(md.includes("**Test Cluster**"));
  assert.ok(md.includes("Canonical: Canonical statement."));
  assert.ok(md.includes("Outcome: Key metric."));
  // Wider coverage should appear before narrower
  const wideIdx = md.indexOf("Wide angle.");
  const shortIdx = md.indexOf("Short angle.");
  assert.ok(wideIdx < shortIdx, "wider-coverage angle should sort first");
  // All-coverage should label "all"
  assert.ok(md.includes("used_in: [all]"));
});

// ---------- new field rendering ----------

test("renderMaster uses rv.career_narrative when provided", () => {
  const rv = { ...fixtureRv, career_narrative: "Custom narrative text 12345." };
  const md = renderMaster(rv, "testprofile", { generatedAt: "2026-05-24", sourceHash: "x" });
  assert.ok(md.includes("Custom narrative text 12345."));
  assert.ok(!md.includes("Placeholder until first manual fill"));
});

test("renderMaster uses rv.languages when provided", () => {
  const rv = {
    ...fixtureRv,
    languages: [
      { name: "English", level: "C1" },
      { name: "Russian", level: "Native" },
    ],
  };
  const md = renderMaster(rv, "testprofile");
  assert.ok(md.includes("- English — C1"));
  assert.ok(md.includes("- Russian — Native"));
});

test("renderMaster renders length_constrained_priority on roles", () => {
  const rv = {
    ...fixtureRv,
    shared_roles: {
      ...fixtureRv.shared_roles,
      croc: { ...fixtureRv.shared_roles.croc, length_constrained_priority: "drop_first" },
    },
  };
  const md = renderMaster(rv, "testprofile");
  assert.ok(md.includes("Length-constrained priority: `drop_first`"));
});

test("renderMaster groups bullets via achievement_clusters when defined", () => {
  const rv = {
    ...fixtureRv,
    achievement_clusters: {
      credit_mentor: [
        {
          id: "shipped",
          name: "Shipped Feature",
          canonical: "Built feature X.",
          outcome: "30% lift.",
          match_patterns: ["shipped feature x"],
        },
      ],
    },
  };
  const md = renderMaster(rv, "testprofile");
  assert.ok(md.includes("Achievement clusters"));
  assert.ok(md.includes("**Shipped Feature**"));
  assert.ok(md.includes("Canonical: Built feature X."));
});
