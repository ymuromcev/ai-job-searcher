// One-shot: rename Workflow/Target Tier/Resume Versions back to English
// titles AND replace their inner content with the latest Russian-bodied
// builders. Run with --profile <id> --apply.
//
// Why a one-shot: build_hub_layout is sentinel-guarded (skips already-
// populated subpages), so it won't replace existing content. This script
// drops every block on each subpage (paginated) and re-appends from the
// builder. Page IDs preserved → no broken links from the hub.

const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

const {
  REPO_ROOT,
  loadEnv,
  parseArgs,
  requireToken,
  banner,
  done,
  fatal,
  validateProfileId,
} = require("./_common.js");

const {
  SUBPAGES,
  buildSubpageBody,
} = require("./build_hub_layout.js");

async function listAllChildren(client, pageId) {
  const out = [];
  let cursor;
  do {
    const resp = await client.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...(resp.results || []));
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function appendChunked(client, pageId, blocks) {
  const CHUNK = 90;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await client.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + CHUNK),
    });
  }
}

async function getPageTitle(client, pageId) {
  const page = await client.pages.retrieve({ page_id: pageId });
  const titleProp = Object.values(page.properties || {}).find((v) => v.type === "title");
  return titleProp?.title?.[0]?.plain_text || "";
}

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("apply_ru_content", args);

  const id = validateProfileId(args.profile);
  const profilePath = path.join(REPO_ROOT, "profiles", id, "profile.json");
  if (!fs.existsSync(profilePath)) fatal(new Error(`profile.json not found: ${profilePath}`));
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  const versionsPath = path.join(
    REPO_ROOT,
    "profiles",
    id,
    (profile.resume && profile.resume.versions_file) || "resume_versions.json"
  );
  const versionsFile = fs.existsSync(versionsPath)
    ? JSON.parse(fs.readFileSync(versionsPath, "utf8"))
    : { versions: {} };

  const subpages = (profile.notion && profile.notion.hub_layout && profile.notion.hub_layout.subpages) || {};
  const token = requireToken(id);
  const client = new Client({ auth: token });

  // Three pages we own: workflow / target_tier / resume_versions.
  // Candidate Profile we leave alone (English content per current spec).
  const targets = SUBPAGES.filter((s) => s.key !== "candidate_profile");

  for (const s of targets) {
    const pageId = subpages[s.key];
    if (!pageId) {
      console.log(`  [${s.key}] no page id in profile.json — skip`);
      continue;
    }
    const currentTitle = await getPageTitle(client, pageId);
    console.log(`\n  [${s.key}] ${pageId} — current title: "${currentTitle}"`);

    // 1. Rename to canonical English if needed
    if (currentTitle !== s.title) {
      console.log(`    will rename "${currentTitle}" → "${s.title}"`);
      if (args.apply) {
        await client.pages.update({
          page_id: pageId,
          properties: { title: { title: [{ type: "text", text: { content: s.title } }] } },
        });
        console.log(`    renamed`);
      }
    }

    // 2. Drop existing inner blocks
    const existing = await listAllChildren(client, pageId);
    console.log(`    existing inner blocks: ${existing.length}`);
    if (args.apply) {
      let deleted = 0;
      for (const b of existing) {
        try {
          await client.blocks.delete({ block_id: b.id });
          deleted++;
        } catch (err) {
          console.log(`      delete failed ${b.id} (${b.type}): ${err.message}`);
        }
      }
      console.log(`    deleted: ${deleted}`);
    }

    // 3. Build fresh body and append
    const body = buildSubpageBody(s.mode, {
      profile,
      versionsFile,
      profileId: id,
    });
    console.log(`    will append ${body.length} new blocks (Russian content)`);
    if (args.apply) {
      await appendChunked(client, pageId, body);
      console.log(`    appended`);
    }
  }

  done("apply_ru_content", { profile_id: id, dry_run: !args.apply });
}

if (require.main === module) {
  main().catch(fatal);
}
