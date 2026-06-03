// `backfill-outreach-url` command (BL-186 / RFC 059 amendment).
//
// One-shot backfill of the LinkedIn people-search URL for vacancies that
// predate the RFC-059 outreach feature. RFC 059's `prepare --phase commit`
// only populates `company_people_search_url` for rows committed AFTER the
// feature shipped — every older `To Apply` / `Applied` row has an empty
// `LinkedIn Search` field in Notion and an empty `company_people_search_url`
// in TSV. This command computes the URL for those rows and writes it to both.
//
// Selection (pure, see `selectBackfillCandidates`):
//   status ∈ {"To Apply", "Applied"} AND empty company_people_search_url
//   AND non-empty companyName → candidate.
//   Same status + empty url but empty companyName → skipped (no company to
//   search on). Non-empty url → alreadySet (idempotency: a second run is a
//   no-op).
//
// Default is dry-run: prints "would enrich N, skip M (no company),
// already set K" and writes nothing. With `--apply`:
//   1. Compute the URL via `buildCompanyPeopleSearchUrl`.
//   2. Write it to TSV through `applications_tsv.js` (the only TSV writer).
//   3. Push it to the Notion `LinkedIn Search` field via the SAME targeted
//      `pages.update` pattern as `check`'s `updatePageStatus`.
//
// Notion write classification: `company_people_search_url` is engine-authored
// one-way data (same class as the `prepare` commit-phase write that created
// it on new rows). This is a targeted single-field `pages.update`, NOT a page
// create and NOT a pull. It does not re-introduce a push path in the
// pull-only sense — `sync` still never pushes, and Notion remains the source
// of truth for operator-owned fields (status, outreach status). See the
// "Amendment — BL-186 backfill" section of `rfc/059-hm-outreach.md`.

const path = require("path");

const profileLoader = require("../core/profile_loader.js");
const { secretEnvName } = profileLoader;
const applications = require("../core/applications_tsv.js");
const notion = require("../core/notion_sync.js");
const { resolveProfilesDir } = require("../core/paths.js");
const { buildCompanyPeopleSearchUrl } = require("../core/linkedin_search_url.js");

// Statuses eligible for backfill. Intentionally narrow (BL-186 NOT-in-scope:
// Inbox / Rejected / Archived / Closed / No Response / Interview / Offer are
// excluded — only the two states where the operator actively wants outreach).
const BACKFILL_STATUSES = new Set(["To Apply", "Applied"]);

const DEFAULT_DEPS = {
  loadProfile: profileLoader.loadProfile,
  loadSecrets: profileLoader.loadSecrets,
  loadApplications: applications.load,
  saveApplications: applications.save,
  makeClient: notion.makeClient,
  // Targeted single-field write — the engine-authored one-way pattern used by
  // `check`'s status update. Injected so tests mock the network.
  updatePageUrl: notion.updateJobPage,
  buildCompanyPeopleSearchUrl,
};

// Pure. Partition loaded apps into the three backfill buckets. No I/O, no
// network, no Date. Returns shallow references to the original app objects so
// the caller can mutate the chosen candidates in place before saving.
//
//   candidates — eligible status, empty url, non-empty companyName.
//   skipped    — eligible status, empty url, but empty companyName.
//   alreadySet — eligible status, non-empty url (idempotency target).
//
// Rows in a non-eligible status are ignored entirely (not counted in any
// bucket) — they are out of scope per BL-186.
function selectBackfillCandidates(apps) {
  const candidates = [];
  const skipped = [];
  const alreadySet = [];
  for (const app of apps || []) {
    if (!BACKFILL_STATUSES.has(app.status)) continue;
    const hasUrl = Boolean(
      app.company_people_search_url && String(app.company_people_search_url).trim()
    );
    if (hasUrl) {
      alreadySet.push(app);
      continue;
    }
    const hasCompany = Boolean(app.companyName && String(app.companyName).trim());
    if (!hasCompany) {
      skipped.push(app);
      continue;
    }
    candidates.push(app);
  }
  return { candidates, skipped, alreadySet };
}

function makeBackfillOutreachUrlCommand(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  return async function backfillOutreachUrlCommand(ctx) {
    const { profileId, flags, env, stdout, stderr } = ctx;
    const profilesDir = resolveProfilesDir(ctx, ctx.env || process.env);

    const profile = deps.loadProfile(profileId, { profilesDir });
    const applicationsPath = path.join(profile.paths.root, "applications.tsv");
    const { apps } = deps.loadApplications(applicationsPath);

    const { candidates, skipped, alreadySet } = selectBackfillCandidates(apps);

    stdout(
      `backfill plan: would enrich ${candidates.length}, ` +
        `skip ${skipped.length} (no company), already set ${alreadySet.length}`
    );

    if (!flags.apply) {
      stdout(`(dry-run — pass --apply to write TSV + Notion)`);
      return 0;
    }

    if (candidates.length === 0) {
      stdout(`nothing to backfill — no eligible rows with empty LinkedIn Search`);
      return 0;
    }

    // Notion push requires a token + a configured property map that actually
    // maps the URL field. Without the `companyPeopleSearchUrl` key the URL
    // would only ever land in TSV and never in Notion — warn loudly but still
    // write the TSV (the local ledger is canonical; Notion is a view).
    const secrets = (deps.loadSecrets && deps.loadSecrets(profileId, env)) || {};
    const token = secrets.NOTION_TOKEN || null;
    const propertyMap =
      (profile.notion && profile.notion.property_map) || notion.DEFAULT_PROPERTY_MAP;
    const hasUrlMapping = Boolean(
      propertyMap.companyPeopleSearchUrl && propertyMap.companyPeopleSearchUrl.field
    );

    let client = null;
    const getClient = () => {
      if (!client) client = deps.makeClient(token);
      return client;
    };

    const canPushNotion = Boolean(token && hasUrlMapping);
    if (!token) {
      stderr(
        `warn: missing ${secretEnvName(profileId, "NOTION_TOKEN")} in env — ` +
          `writing TSV only, Notion LinkedIn Search not updated`
      );
    } else if (!hasUrlMapping) {
      stderr(
        `warn: profile.notion.property_map has no "companyPeopleSearchUrl" key — ` +
          `writing TSV only, Notion LinkedIn Search not updated`
      );
    }

    let enriched = 0;
    let notionPushed = 0;
    let notionErrors = 0;

    for (const app of candidates) {
      const url = deps.buildCompanyPeopleSearchUrl({
        company: app.companyName,
        roleTitle: app.title,
        location: (app.locations && app.locations[0]) || undefined,
      });
      // TSV mutation in memory — saved once after the loop through the single
      // TSV writer module. We do NOT bump updatedAt: this is a backfill of a
      // derived field, not a state change, and bumping the timestamp would make
      // every old row look freshly touched.
      app.company_people_search_url = url;
      enriched += 1;

      if (canPushNotion && app.notion_page_id) {
        try {
          await deps.updatePageUrl(
            getClient(),
            app.notion_page_id,
            { companyPeopleSearchUrl: url },
            propertyMap
          );
          notionPushed += 1;
        } catch (err) {
          notionErrors += 1;
          stderr(`  notion error for ${app.key} (${app.notion_page_id}): ${err.message}`);
        }
      }
    }

    deps.saveApplications(applicationsPath, apps);

    const notionNote = canPushNotion
      ? `${notionPushed} Notion page(s) updated` +
        (notionErrors ? `, ${notionErrors} Notion error(s)` : "")
      : `Notion push skipped`;
    stdout(`applied: enriched ${enriched} TSV row(s), ${notionNote}`);

    return notionErrors > 0 ? 1 : 0;
  };
}

module.exports = makeBackfillOutreachUrlCommand();
module.exports.makeBackfillOutreachUrlCommand = makeBackfillOutreachUrlCommand;
module.exports.selectBackfillCandidates = selectBackfillCandidates;
module.exports.BACKFILL_STATUSES = BACKFILL_STATUSES;
