const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SUBPAGES,
  HUB_LAYOUT_SENTINEL,
  hasHubLayoutSentinelV1,
  subpageSentinel,
  buildCandidateProfileBlocks,
  buildWorkflowBlocks,
  buildTargetTierBlocks,
  buildResumeVersionsSubpageBlocks,
  buildLayoutBody,
  buildSubpageBody,
  splitList,
} = require("./build_hub_layout.js");

// ---------------------------------------------------------------------------
// splitList
// ---------------------------------------------------------------------------

test("splitList: handles array, comma-string, semicolon-string, newlines", () => {
  assert.deepEqual(splitList(["a", " b ", ""]), ["a", "b"]);
  assert.deepEqual(splitList("a, b, c"), ["a", "b", "c"]);
  assert.deepEqual(splitList("a; b;;c"), ["a", "b", "c"]);
  assert.deepEqual(splitList("a\nb\n\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList(null), []);
  assert.deepEqual(splitList(42), []);
});

// ---------------------------------------------------------------------------
// subpageSentinel + sentinel detection
// ---------------------------------------------------------------------------

test("subpageSentinel: distinct per key", () => {
  assert.equal(subpageSentinel("candidate_profile"), "⟡ stage18-candidate_profile-v1");
  assert.equal(subpageSentinel("workflow"), "⟡ stage18-workflow-v1");
  assert.notEqual(subpageSentinel("a"), subpageSentinel("b"));
});

test("hasHubLayoutSentinelV1: accepts both stage16 and stage18 sentinels", () => {
  const stage16 = {
    type: "paragraph",
    paragraph: {
      rich_text: [
        { plain_text: "⟡ hub-layout-v1 (managed by scripts/stage16/build_hub_layout.js)" },
      ],
    },
  };
  const stage18 = {
    type: "paragraph",
    paragraph: {
      rich_text: [
        { plain_text: "⟡ hub-layout-v1 (managed by scripts/stage18/build_hub_layout.js)" },
      ],
    },
  };
  const other = {
    type: "paragraph",
    paragraph: { rich_text: [{ plain_text: "unrelated" }] },
  };
  assert.equal(hasHubLayoutSentinelV1([stage16]), true);
  assert.equal(hasHubLayoutSentinelV1([stage18]), true);
  assert.equal(hasHubLayoutSentinelV1([other]), false);
  assert.equal(hasHubLayoutSentinelV1([]), false);
});

// ---------------------------------------------------------------------------
// SUBPAGES config
// ---------------------------------------------------------------------------

test("SUBPAGES: all 4 canonical pages present with title+icon+mode", () => {
  const titles = SUBPAGES.map((s) => s.title);
  assert.deepEqual(titles, ["Candidate Profile", "Workflow", "Target Tier", "Resume Versions"]);
  for (const s of SUBPAGES) {
    assert.ok(s.key, "key missing");
    assert.ok(s.title, "title missing");
    assert.ok(s.icon, "icon missing");
    assert.ok(s.mode, "mode missing");
  }
});

// ---------------------------------------------------------------------------
// Candidate Profile block builder
// ---------------------------------------------------------------------------

test("buildCandidateProfileBlocks: uses identity + preferences, ends with sentinel", () => {
  const profile = {
    identity: {
      name: "JARED MOORE",
      location: "Sacramento, CA",
      email: "jared@example.com",
      phone: "+1 555",
      linkedin: "linkedin.com/in/jared",
    },
    preferences: {
      level: "Senior",
      years_experience: 7,
      salary_min_total_comp: 180000,
      salary_currency: "USD",
      work_format: "Hybrid",
      target_roles: "Product Manager, Senior PM",
      locations_ok: ["Remote US", "Sacramento"],
    },
  };
  const blocks = buildCandidateProfileBlocks(profile);
  assert.ok(blocks.length >= 8);

  // First block: heading2 "Candidate Profile"
  assert.equal(blocks[0].type, "heading_2");
  assert.equal(blocks[0].heading_2.rich_text[0].text.content, "Candidate Profile");

  // Must include each identity line. Extract rich_text from any block
  // variant (paragraph / bulleted_list_item / heading_3) so the assertions
  // don't care which Notion block type the impl chose.
  const texts = blocks.map((b) => {
    const payload =
      (b.paragraph && b.paragraph.rich_text) ||
      (b.bulleted_list_item && b.bulleted_list_item.rich_text) ||
      (b.heading_3 && b.heading_3.rich_text) ||
      [];
    return payload.map((r) => r.text.content).join("");
  });
  assert.ok(texts.some((t) => t.includes("Name: JARED MOORE")));
  assert.ok(texts.some((t) => t.includes("Location: Sacramento, CA")));
  assert.ok(texts.some((t) => t.includes("Email: jared@example.com")));
  assert.ok(texts.some((t) => t.includes("LinkedIn: linkedin.com/in/jared")));
  assert.ok(texts.some((t) => t.includes("Level: Senior")));
  assert.ok(texts.some((t) => t.includes("Years of experience: 7")));

  // Target Roles split into bullets
  const bulletTexts = blocks
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(bulletTexts.includes("Product Manager"));
  assert.ok(bulletTexts.includes("Senior PM"));

  // Preferences bullets
  assert.ok(bulletTexts.some((t) => t.includes("Min total comp: 180,000 USD")));
  assert.ok(bulletTexts.some((t) => t.includes("Work format: Hybrid")));
  assert.ok(bulletTexts.some((t) => t.includes("Locations OK: Remote US, Sacramento")));

  // Last block: sentinel
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "paragraph");
  assert.equal(
    last.paragraph.rich_text[0].text.content,
    subpageSentinel("candidate_profile")
  );
});

test("buildCandidateProfileBlocks: empty profile still produces heading + sentinel", () => {
  const blocks = buildCandidateProfileBlocks({});
  assert.equal(blocks[0].type, "heading_2");
  assert.equal(
    blocks[blocks.length - 1].paragraph.rich_text[0].text.content,
    subpageSentinel("candidate_profile")
  );
});

// ---------------------------------------------------------------------------
// Workflow block builder
// ---------------------------------------------------------------------------

test("buildWorkflowBlocks: mentions cli.js + profile id + sentinel", () => {
  const blocks = buildWorkflowBlocks("profile_b");
  const joined = JSON.stringify(blocks);
  assert.ok(joined.includes("node engine/cli.js scan --profile profile_b"));
  assert.ok(joined.includes("--phase pre"));
  assert.ok(joined.includes("--phase commit"));
  assert.ok(joined.includes("check --profile profile_b --prepare"));
  assert.ok(joined.includes("validate --profile profile_b"));
  assert.ok(joined.includes("sync --profile profile_b"));
  const last = blocks[blocks.length - 1];
  assert.equal(last.paragraph.rich_text[0].text.content, subpageSentinel("workflow"));
});

// ---------------------------------------------------------------------------
// Target Tier block builder
// ---------------------------------------------------------------------------

test("buildTargetTierBlocks: counts tiers from flat company_tiers map", () => {
  const profile = {
    company_tiers: {
      Stripe: "S",
      Visa: "S",
      Ramp: "A",
      Brex: "A",
      Chime: "A",
      Sardine: "B",
      Earnin: "C",
    },
  };
  const blocks = buildTargetTierBlocks(profile);
  const bulletTexts = blocks
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(bulletTexts.some((t) => t.startsWith("S (2) — ")));
  assert.ok(bulletTexts.some((t) => t.startsWith("A (3) — ")));
  assert.ok(bulletTexts.some((t) => t.startsWith("B (1) — ")));
  assert.ok(bulletTexts.some((t) => t.startsWith("C (1) — ")));

  const paragraphTexts = blocks
    .filter((b) => b.type === "paragraph")
    .map((b) => b.paragraph.rich_text[0].text.content);
  assert.ok(paragraphTexts.some((t) => t.includes("S:2") && t.includes("A:3")));
  const last = blocks[blocks.length - 1];
  assert.equal(last.paragraph.rich_text[0].text.content, subpageSentinel("target_tier"));
});

test("buildTargetTierBlocks: empty tiers all zero", () => {
  const blocks = buildTargetTierBlocks({});
  const bulletTexts = blocks
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(bulletTexts.some((t) => t.startsWith("S (0) — ")));
});

// ---------------------------------------------------------------------------
// Resume Versions block builder
// ---------------------------------------------------------------------------

test("buildResumeVersionsSubpageBlocks: one bullet per archetype + sentinel", () => {
  const versionsFile = {
    versions: {
      pm_default: { title: "Senior PM", summary: "Generalist PM." },
      pm_fintech: { title: "Fintech PM" },
    },
  };
  const blocks = buildResumeVersionsSubpageBlocks(versionsFile);
  const bullets = blocks.filter((b) => b.type === "bulleted_list_item");
  assert.equal(bullets.length, 2);
  const texts = bullets.map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(texts[0].startsWith("pm_default — Senior PM. Generalist PM."));
  assert.ok(texts[1].startsWith("pm_fintech — Fintech PM"));
  const last = blocks[blocks.length - 1];
  assert.equal(last.paragraph.rich_text[0].text.content, subpageSentinel("resume_versions"));
});

test("buildResumeVersionsSubpageBlocks: no versions still emits heading + sentinel", () => {
  const blocks = buildResumeVersionsSubpageBlocks({ versions: {} });
  assert.equal(blocks[0].type, "heading_2");
  assert.equal(
    blocks[blocks.length - 1].paragraph.rich_text[0].text.content,
    subpageSentinel("resume_versions")
  );
});

// ---------------------------------------------------------------------------
// Main layout body
// ---------------------------------------------------------------------------

test("buildLayoutBody: intro → candidate link → column_list → divider → sentinel", () => {
  const blocks = buildLayoutBody({
    profileName: "Jared Moore",
    subpageIds: {
      candidate_profile: "pg-candidate",
      workflow: "pg-workflow",
      target_tier: "pg-tier",
      resume_versions: "pg-resume",
    },
    dbIds: {
      companies_db_id: "db-companies",
      application_qa_db_id: "db-qa",
      job_platforms_db_id: "db-platforms",
    },
    inboxCount: 42,
    updatedAt: "2026-04-22",
  });

  assert.equal(blocks[0].type, "paragraph"); // intro
  assert.ok(blocks[0].paragraph.rich_text[0].text.content.includes("Jared Moore"));

  assert.equal(blocks[1].type, "link_to_page");
  assert.equal(blocks[1].link_to_page.type, "page_id");
  assert.equal(blocks[1].link_to_page.page_id, "pg-candidate");

  const columnList = blocks[2];
  assert.equal(columnList.type, "column_list");
  const cols = columnList.column_list.children;
  assert.equal(cols.length, 3);

  // Col 1: callout
  const col1Children = cols[0].column.children;
  assert.equal(col1Children[0].type, "callout");
  assert.ok(col1Children[0].callout.rich_text[0].text.content.includes("Inbox: 42"));
  assert.ok(col1Children[0].callout.rich_text[0].text.content.includes("2026-04-22"));
  assert.equal(col1Children[0].callout.icon.emoji, "📥");

  // Col 2: Playbooks heading + 3 page links
  const col2Children = cols[1].column.children;
  assert.equal(col2Children[0].type, "heading_2");
  const pageLinks = col2Children.filter((b) => b.type === "link_to_page");
  assert.equal(pageLinks.length, 3);
  assert.equal(pageLinks[0].link_to_page.page_id, "pg-workflow");
  assert.equal(pageLinks[1].link_to_page.page_id, "pg-tier");
  assert.equal(pageLinks[2].link_to_page.page_id, "pg-resume");

  // Col 3: Databases heading + 3 database links
  const col3Children = cols[2].column.children;
  const dbLinks = col3Children.filter((b) => b.type === "link_to_page");
  assert.equal(dbLinks.length, 3);
  assert.equal(dbLinks[0].link_to_page.database_id, "db-companies");
  assert.equal(dbLinks[1].link_to_page.database_id, "db-qa");
  assert.equal(dbLinks[2].link_to_page.database_id, "db-platforms");

  assert.equal(blocks[3].type, "divider");

  // Last: sentinel
  const last = blocks[blocks.length - 1];
  assert.equal(last.type, "paragraph");
  assert.equal(last.paragraph.rich_text[0].text.content, HUB_LAYOUT_SENTINEL);
});

test("buildLayoutBody: omits candidate link when id missing, skips missing DB ids", () => {
  const blocks = buildLayoutBody({
    profileName: "Pat",
    subpageIds: { workflow: "pg-wf" },
    dbIds: { companies_db_id: "db-c" },
    inboxCount: 0,
    updatedAt: "2026-04-22",
  });
  // No candidate_profile link → second block is column_list directly
  assert.equal(blocks[1].type, "column_list");
  const col3Children = blocks[1].column_list.children[2].column.children;
  const dbLinks = col3Children.filter((b) => b.type === "link_to_page");
  assert.equal(dbLinks.length, 1);
  assert.equal(dbLinks[0].link_to_page.database_id, "db-c");
});

// ---------------------------------------------------------------------------
// buildSubpageBody dispatcher
// ---------------------------------------------------------------------------

test("buildSubpageBody: dispatches to the right builder per mode", () => {
  const ctx = {
    profile: { identity: { name: "X" }, preferences: {}, company_tiers: {} },
    versionsFile: { versions: {} },
    profileId: "x",
  };
  for (const mode of ["candidate_profile", "workflow", "target_tier", "resume_versions"]) {
    const blocks = buildSubpageBody(mode, ctx);
    assert.ok(blocks.length > 0, `${mode} produced no blocks`);
    const last = blocks[blocks.length - 1];
    assert.equal(last.paragraph.rich_text[0].text.content, subpageSentinel(mode));
  }
});

test("buildSubpageBody: unknown mode throws", () => {
  assert.throws(
    () => buildSubpageBody("nonsense", { profile: {}, versionsFile: {}, profileId: "x" }),
    /unknown subpage mode/
  );
});
