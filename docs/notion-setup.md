# Notion integration setup

Per-profile setup. Each profile has its own Notion integration token,
stored in repo-root `.env` under the namespaced key
`<PROFILE_ID_UPPER>_NOTION_TOKEN` (e.g. `ME_NOTION_TOKEN`,
`JARED_NOTION_TOKEN`). Tokens are never read by Notion through any
shared/global env var; the loader strips the prefix before handing it
to engine code.

## 1. Create the integration

1. Open <https://www.notion.so/profile/integrations>.
2. Click **New integration**.
3. **Name** — anything (`ai-job-searcher` is fine).
4. **Workspace** — the workspace where your job-search hub lives.
5. **Type: Internal.** (Public is for third-party apps you'd distribute;
   we don't need it.)
6. **Capabilities** — enable:
   - Read content
   - Update content
   - Insert content
   - Read comments + Insert comments — recommended; needed for
     `/job-pipeline check` to leave status comments on Jobs DB rows.
7. **User information** — `No user information`. The pipeline never
   reads other users' personal data.
8. **Save** → on the next screen copy the **Internal Integration Secret**
   (starts with `ntn_…`). This is the only time it's shown in full;
   if you lose it, regenerate.

## 2. Drop the token into `.env`

In repo root, add the line for whichever profile id you'll use:

```
ME_NOTION_TOKEN=ntn_...
```

`.env` is gitignored. The PII pre-commit hook (`.git-hooks/pre-commit`)
also scans diffs for common token patterns as a backup.

## 3. Grant page access — required

Notion integrations see **nothing** until you explicitly grant access to
a page. The onboarding wizard (`deploy_profile.js`) creates the
per-profile Companies and Jobs Pipeline databases **under a parent page**
— that parent page needs to be shared with the integration, or the
wizard fails with `object_not_found`.

For the parent page you'll point the wizard at (the URL you put in the
intake form's `notion.parent_page_url` field):

1. Open the page in Notion.
2. Top-right `…` menu → **Connections** → **Connect to**.
3. Pick your integration. Confirm.

The connection cascades to all sub-pages — connecting once at the hub
page level is enough for everything the wizard provisions underneath it.

### Security: scope it tight

Connect the integration to the smallest subtree it actually needs.
If you connect at the workspace root, the integration can read and
write **every** page in the workspace. The pipeline only needs the
single candidate hub page (and its descendants).

## 4. Verify

Run the deploy in dry-run first; it pre-fetches the parent page
metadata and fails loudly if access isn't granted:

```bash
node scripts/stage18/deploy_profile.js --profile me
```

Common failure modes:

| Error | Cause |
|---|---|
| `Could not find page with ID …` | Integration not connected to the parent page (step 3). |
| `Unauthorized` / 401 | Token wrong or revoked — recheck `.env`. |
| `Capabilities` / 403 on writes | Integration capabilities missing — re-edit at notion.so/profile/integrations. |

Once dry-run prints a clean plan, re-run with `--apply` to actually
provision.

## Multiple profiles

Each profile gets its own integration. Don't reuse one integration
across profiles — token rotation, capability scoping, and access
auditing are all per-integration in Notion. The `.env` namespacing
matches that: `ME_NOTION_TOKEN`, `LILIA_NOTION_TOKEN`,
`JARED_NOTION_TOKEN`, etc.
