// Stage 18 — reset a profile's Notion hub so build_hub_layout can rebuild it.
//
// What this does (one-shot, idempotent):
//   1. Lists children of the workspace (hub) page.
//   2. Archives every direct child_page that matches a known subpage key in
//      profile.notion.hub_layout.subpages (Candidate Profile / Workflow /
//      Target Tier / Resume Versions). Archive is non-destructive — pages
//      stay restorable from Notion's trash for 30 days.
//   3. Deletes every NON-child_page block on the hub page (the intro
//      paragraph + candidate link + column_list + divider + sentinel) —
//      i.e. the body that build_hub_layout appends. This wipes the
//      `hub-layout-v1` sentinel so a re-run will re-append.
//   4. Strips `notion.hub_layout.subpages` from profile.json so the next
//      build_hub_layout creates fresh subpages.
//
// What this does NOT touch:
//   • child_page blocks not in the subpages map (extra pages you may have
//     added manually).
//   • Linked DBs (Companies / Jobs Pipeline / Aux DBs) — they live as their
//     own blocks but are referenced via link_to_page, not embedded.
//
// Default --dry-run. Pass --apply to actually mutate Notion + profile.json.
//
// Usage:
//   node scripts/stage18/reset_hub_layout.js --profile lilia            # dry-run
//   node scripts/stage18/reset_hub_layout.js --profile lilia --apply

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

async function listChildren(client, pageId) {
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

async function main() {
  loadEnv();
  const args = parseArgs();
  banner("reset_hub_layout", args);

  const id = validateProfileId(args.profile);
  const profilePath = path.join(REPO_ROOT, "profiles", id, "profile.json");
  if (!fs.existsSync(profilePath)) fatal(new Error(`profile.json not found: ${profilePath}`));
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));

  const notion = profile.notion || {};
  const workspacePageId = notion.workspace_page_id;
  if (!workspacePageId) fatal(new Error("profile.notion.workspace_page_id missing"));
  const subpages = (notion.hub_layout && notion.hub_layout.subpages) || {};
  const knownSubpageIds = new Set(Object.values(subpages));

  const token = requireToken(id);
  const client = new Client({ auth: token });

  console.log(`  workspace_page_id: ${workspacePageId}`);
  console.log(`  known subpages:    ${Object.keys(subpages).join(", ") || "(none)"}`);

  const children = await listChildren(client, workspacePageId);
  console.log(`  children fetched:  ${children.length}`);

  // Whitelist of body block types build_hub_layout appends. Anything outside
  // this list — and ESPECIALLY child_database / child_page — is preserved.
  // Deleting a child_database block ARCHIVES THE UNDERLYING DATABASE (and
  // every page in it). We never want that.
  const DELETABLE_BODY_TYPES = new Set([
    "paragraph",
    "column_list",
    "divider",
    "heading_1",
    "heading_2",
    "heading_3",
    "callout",
    "link_to_page",
  ]);

  // 1) Subpage archival: drive from profile.json subpages map directly, not
  //    from the children listing — subpage may live deeper than direct child
  //    or have a stale id. pages.update with a stale id will simply error,
  //    which we tolerate.
  const subpageBlocksToArchive = [];
  for (const [key, pid] of Object.entries(subpages)) {
    if (pid) subpageBlocksToArchive.push({ key, id: pid });
  }

  // 2) Body deletion: only top-level non-page non-database blocks of known
  //    decorative types.
  const bodyBlocksToDelete = [];
  const preserved = [];
  for (const block of children) {
    if (block.type === "child_database") {
      preserved.push({ type: "child_database", id: block.id });
      continue;
    }
    if (block.type === "child_page") {
      preserved.push({
        type: "child_page",
        id: block.id,
        title: block.child_page && block.child_page.title,
      });
      continue;
    }
    if (DELETABLE_BODY_TYPES.has(block.type)) {
      bodyBlocksToDelete.push({ id: block.id, type: block.type });
    } else {
      preserved.push({ type: block.type, id: block.id });
    }
  }

  if (preserved.length) {
    console.log(`\n  preserved (NOT touched): ${preserved.length}`);
    for (const p of preserved) {
      console.log(`    [keep] ${p.type} ${p.id}${p.title ? ` "${p.title}"` : ""}`);
    }
  }

  console.log(`\n  archive subpages: ${subpageBlocksToArchive.length}`);
  for (const s of subpageBlocksToArchive) console.log(`    [archive] ${s.key} ${s.id}`);

  console.log(`\n  delete body blocks: ${bodyBlocksToDelete.length}`);
  for (const b of bodyBlocksToDelete) console.log(`    [delete] ${b.type} ${b.id}`);

  if (!args.apply) {
    console.log("\n  (dry-run — pass --apply to perform)");
    done("reset_hub_layout", { dry_run: true, archived: subpageBlocksToArchive.length, deleted: bodyBlocksToDelete.length });
    return;
  }

  // --- Apply: archive subpages first, then delete body blocks. Order
  // doesn't strictly matter, but archiving subpages first makes the hub
  // page visibly clean before body blocks come down. ---
  let archived = 0;
  let archiveErrors = 0;
  for (const s of subpageBlocksToArchive) {
    try {
      await client.pages.update({ page_id: s.id, archived: true });
      archived++;
      console.log(`    archived: ${s.key} ${s.id}`);
    } catch (err) {
      archiveErrors++;
      console.log(`    archive FAILED ${s.key} ${s.id}: ${err.message}`);
    }
  }

  let deleted = 0;
  let deleteErrors = 0;
  for (const b of bodyBlocksToDelete) {
    try {
      await client.blocks.delete({ block_id: b.id });
      deleted++;
    } catch (err) {
      deleteErrors++;
      console.log(`    delete FAILED ${b.type} ${b.id}: ${err.message}`);
    }
  }
  console.log(`    deleted ${deleted} body blocks`);

  // --- Strip subpages from profile.json so build_hub_layout creates fresh
  // ones (otherwise it'd try to write into the archived ids). ---
  if (notion.hub_layout && notion.hub_layout.subpages) {
    delete notion.hub_layout.subpages;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n");
    console.log("  [profile.json] cleared notion.hub_layout.subpages");
  }

  done("reset_hub_layout", {
    archived,
    archive_errors: archiveErrors,
    deleted,
    delete_errors: deleteErrors,
  });
}

if (require.main === module) {
  main().catch(fatal);
}

module.exports = { main };
