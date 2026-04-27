const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SUBPAGES,
  LEGACY_TITLES,
  HUB_LAYOUT_SENTINEL,
  hasHubLayoutSentinelV1,
  subpageSentinel,
  buildCandidateProfileBlocks,
  buildWorkflowBlocks,
  buildTargetTierBlocks,
  buildResumeVersionsSubpageBlocks,
  buildIntro,
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
  // All four subpages keep English titles (stable labels used across the
  // codebase, Notion search, and tests). The PAGE BODIES are localized for
  // workflow / target_tier / resume_versions — see body builder tests.
  const titles = SUBPAGES.map((s) => s.title);
  assert.deepEqual(titles, ["Candidate Profile", "Workflow", "Target Tier", "Resume Versions"]);
  for (const s of SUBPAGES) {
    assert.ok(s.key, "key missing");
    assert.ok(s.title, "title missing");
    assert.ok(s.icon, "icon missing");
    assert.ok(s.mode, "mode missing");
  }
});

test("LEGACY_TITLES: covers historical titles so re-runs rename in-place", () => {
  // For ~24h on 2026-04-27 the three subpages had Russian titles before we
  // moved Russian to the body and reverted titles to English. Profiles that
  // ran build_hub_layout in that window need the Russian variants in
  // LEGACY_TITLES so the next run renames them back.
  assert.ok(LEGACY_TITLES.workflow.includes("Воркфлоу"));
  assert.ok(LEGACY_TITLES.target_tier.includes("Тиры компаний"));
  assert.ok(LEGACY_TITLES.resume_versions.includes("Версии резюме"));
  // No legacy entry for candidate_profile — title hasn't changed.
  assert.equal(LEGACY_TITLES.candidate_profile, undefined);
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

test("buildWorkflowBlocks: opens with a Russian profile-binding callout", () => {
  // The very first block on every Workflow subpage is a Russian-language
  // callout that loudly states the per-profile invocation pattern. This
  // is the answer to "как вызывать команды именно для этого профиля".
  const blocks = buildWorkflowBlocks("lilia");
  const first = blocks[0];
  assert.equal(first.type, "callout");
  const text = first.callout.rich_text.map((r) => r.text.content).join("");
  assert.ok(text.includes("--profile lilia"), "callout references --profile lilia");
  assert.ok(text.includes("node engine/cli.js scan --profile lilia"), "shows full example");
  assert.ok(/Этот профиль|вызыв/.test(text), "Russian framing present");
  assert.ok(text.includes("job-pipeline"));
  assert.ok(text.includes("interview-coach"));
  // Per-profile flag appears at least three times: instruction, example,
  // and the data-dir reminder. Count via global regex.
  const matches = text.match(/--profile lilia/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 mentions of --profile lilia, got ${matches.length}`);
});

test("buildWorkflowBlocks: callout substitutes the right profile id (jared, lilia, …)", () => {
  for (const id of ["jared", "lilia", "weird_id_42"]) {
    const blocks = buildWorkflowBlocks(id);
    const first = blocks[0];
    assert.equal(first.type, "callout");
    const text = first.callout.rich_text.map((r) => r.text.content).join("");
    assert.ok(text.includes(`--profile ${id}`), `id=${id} expected --profile ${id}`);
    assert.ok(text.includes(`profiles/${id}/`), `id=${id} expected profiles/${id}/ data-dir hint`);
  }
});

test("buildWorkflowBlocks: intro paragraph after callout is Russian + parametrized", () => {
  // Block #2 is the human-readable intro paragraph. Body copy is Russian,
  // but technical tokens (--profile <id>, skill names) stay verbatim so
  // they remain copy-pasteable and grep-able.
  const blocks = buildWorkflowBlocks("lilia");
  const second = blocks[1];
  assert.equal(second.type, "paragraph");
  const intro = second.paragraph.rich_text.map((r) => r.text.content).join("");
  assert.ok(intro.includes("--profile lilia"));
  assert.ok(intro.includes("job-pipeline"));
  assert.ok(intro.includes("interview-coach"));
  // Russian body copy markers
  assert.ok(/Автоматический|пайплайн|команда/.test(intro), `expected Russian body, got: ${intro}`);
});

test("buildWorkflowBlocks: section headings are in Russian", () => {
  // The user's working language is Russian; section headings on the
  // Workflow subpage are translated. Command names + CLI args remain
  // verbatim because they're literal tokens.
  const blocks = buildWorkflowBlocks("lilia");
  const headings = blocks
    .filter((b) => b.type === "heading_2" || b.type === "heading_3")
    .map((b) =>
      ((b.heading_2 || b.heading_3).rich_text || [])
        .map((r) => r.text.content)
        .join("")
    );
  // At least one h2 must be in Russian
  assert.ok(
    headings.some((h) => /Команды|Ограничения|Ключевые файлы|Триггеры/.test(h)),
    `expected at least one Russian h2 heading, got: ${headings.join(" | ")}`
  );
  // Headings include a Russian descriptor on key commands
  assert.ok(headings.some((h) => h.includes("Найти новые вакансии")), "scan heading translated");
  assert.ok(headings.some((h) => h.includes("Подготовить материалы")), "prepare heading translated");
  assert.ok(headings.some((h) => h.includes("Синхронизировать")), "sync heading translated");
});

test("buildWorkflowBlocks: uses unified 8-status set (no Phone Screen / Onsite / Inbox transitions)", () => {
  const blocks = buildWorkflowBlocks("p");
  const joined = JSON.stringify(blocks);
  assert.ok(joined.includes("Interview"), "workflow should mention Interview status");
  assert.ok(!joined.includes("Inbox →"), "no Inbox transition");
  assert.ok(!joined.includes("→ Phone Screen"), "no transition to Phone Screen status");
  assert.ok(!joined.includes("Phone Screen →"), "no transition from Phone Screen status");
  assert.ok(!joined.includes("Onsite →"), "no transition from Onsite status");
  assert.ok(!joined.includes("→ Onsite"), "no transition to Onsite status");
  assert.ok(!joined.includes("Inbox + To Apply"), "company cap should not include Inbox");
});

test("buildWorkflowBlocks: ignores legacy flavor field — single workflow for all profiles", () => {
  // Healthcare flavor was retired 2026-04-27. A profile that still has the
  // field set should produce the same skill-commands workflow as any other.
  const profile = {
    flavor: "healthcare",
    preferences: { target_roles: ["Medical Receptionist"] },
  };
  const blocksWithFlavor = buildWorkflowBlocks("lilia", profile);
  const blocksWithout = buildWorkflowBlocks("lilia");
  assert.equal(blocksWithFlavor.length, blocksWithout.length);
  const joined = JSON.stringify(blocksWithFlavor);
  assert.ok(joined.includes("interview-coach"), "interview-coach surfaced regardless of flavor");
  assert.ok(joined.includes("scan --profile lilia"), "skill commands parametrized by id");
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

test("buildTargetTierBlocks: heading + body are in Russian", () => {
  const blocks = buildTargetTierBlocks({ company_tiers: { Stripe: "S" } });
  assert.equal(blocks[0].type, "heading_2");
  assert.equal(blocks[0].heading_2.rich_text[0].text.content, "Тиры компаний");
  // Intro paragraph (block #1) is Russian
  const intro = blocks[1].paragraph.rich_text[0].text.content;
  assert.ok(/тиров|компаний|приоритет/.test(intro), `expected Russian intro, got: ${intro}`);
  // Bullet bodies are Russian
  const bullets = blocks
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => b.bulleted_list_item.rich_text[0].text.content);
  assert.ok(bullets.some((t) => t.includes("компании мечты")), "S tier body in Russian");
  // Counts paragraph is Russian
  const paragraphs = blocks
    .filter((b) => b.type === "paragraph")
    .map((b) => b.paragraph.rich_text[0].text.content);
  assert.ok(paragraphs.some((t) => t.includes("Текущие счётчики")), "counts label in Russian");
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

test("buildResumeVersionsSubpageBlocks: heading + intro are in Russian", () => {
  const blocks = buildResumeVersionsSubpageBlocks({ versions: { x: { title: "X" } } });
  assert.equal(blocks[0].heading_2.rich_text[0].text.content, "Версии резюме");
  const intro = blocks[1].paragraph.rich_text[0].text.content;
  assert.ok(/Архетипы|архетип/.test(intro), `expected Russian intro, got: ${intro}`);
  assert.ok(intro.includes("resume_versions.json"), "filename token preserved");
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

  // Col 1: callout — "Inbox: N" semantics (status='To Apply' && !notion_page_id)
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

test("buildLayoutBody: with `profile` argument uses preferences-driven intro", () => {
  const profile = {
    identity: { name: "JARED MOORE", location: "Sacramento, CA" },
    preferences: {
      target_roles: ["Senior AI Product Manager"],
      target_industries: ["Fintech", "Digital Banking"],
      work_format: "Remote",
    },
  };
  const blocks = buildLayoutBody({
    profileName: "Jared Moore",
    profile,
    subpageIds: {},
    dbIds: {},
    inboxCount: 0,
    updatedAt: "2026-04-27",
  });
  const intro = blocks[0].paragraph.rich_text[0].text.content;
  assert.ok(intro.startsWith("Central command for Jared's US job search."), `got: ${intro}`);
  assert.ok(intro.includes("Senior AI Product Manager"));
  assert.ok(intro.includes("Sacramento, CA"));
  assert.ok(intro.includes("Remote-friendly"));
});

test("buildLayoutBody: profile.hub.intro override wins over template", () => {
  const profile = {
    identity: { name: "Jared", location: "Anywhere" },
    preferences: { target_roles: ["X"] },
    hub: { intro: "Custom intro text — bespoke." },
  };
  const blocks = buildLayoutBody({
    profileName: "Jared",
    profile,
    subpageIds: {},
    dbIds: {},
    inboxCount: 5,
    updatedAt: "2026-04-27",
  });
  assert.equal(blocks[0].paragraph.rich_text[0].text.content, "Custom intro text — bespoke.");
});

// ---------------------------------------------------------------------------
// buildIntro
// ---------------------------------------------------------------------------

test("buildIntro: minimal profile (only name) emits readable fallback", () => {
  const block = buildIntro({ identity: { name: "Sam Carter" } });
  const text = block.paragraph.rich_text[0].text.content;
  assert.ok(text.includes("Sam"));
  assert.ok(text.startsWith("Central command for"));
});

test("buildIntro: ALL-CAPS first name pretty-cased", () => {
  const block = buildIntro({ identity: { name: "JARED MOORE" } });
  const text = block.paragraph.rich_text[0].text.content;
  assert.ok(text.includes("Jared"));
  assert.ok(!text.includes("JARED"));
});

test("buildIntro: industry phrasing — 1 / 2 / 3+ industries", () => {
  const one = buildIntro({
    identity: { name: "X" },
    preferences: { target_roles: ["PM"], target_industries: ["Healthcare"] },
  }).paragraph.rich_text[0].text.content;
  assert.ok(one.includes("in Healthcare"));

  const two = buildIntro({
    identity: { name: "X" },
    preferences: { target_roles: ["PM"], target_industries: ["Fintech", "SaaS"] },
  }).paragraph.rich_text[0].text.content;
  assert.ok(two.includes("in Fintech and SaaS"));

  const many = buildIntro({
    identity: { name: "X" },
    preferences: { target_roles: ["PM"], target_industries: ["A", "B", "C", "D"] },
  }).paragraph.rich_text[0].text.content;
  assert.ok(many.includes("in A, B and adjacent industries"));
});

test("buildIntro: work_format phrasing — remote / any / hybrid / onsite / unset", () => {
  const cases = {
    remote: "Remote-friendly",
    any: "Remote-friendly",
    hybrid: "Hybrid acceptable",
    onsite: "Onsite preferred",
    "on-site": "Onsite preferred",
  };
  for (const [fmt, expected] of Object.entries(cases)) {
    const text = buildIntro({
      identity: { name: "X" },
      preferences: { target_roles: ["PM"], work_format: fmt },
    }).paragraph.rich_text[0].text.content;
    assert.ok(text.includes(expected), `format=${fmt} should yield "${expected}", got: ${text}`);
  }
  // Unset → no format suffix
  const noFmt = buildIntro({
    identity: { name: "X" },
    preferences: { target_roles: ["PM"] },
  }).paragraph.rich_text[0].text.content;
  assert.ok(!noFmt.includes("Remote-friendly"));
  assert.ok(!noFmt.includes("Hybrid"));
  assert.ok(!noFmt.includes("Onsite"));
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
