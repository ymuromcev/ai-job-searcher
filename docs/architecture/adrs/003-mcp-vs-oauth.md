# ADR 003 — Gmail reading via Claude MCP, not stored OAuth

- Status: accepted
- Decided: 2026-04-20
- Crystallizes: [RFC 002](../../../rfc/002-check-command.md)

## Context

The `check` command reads the maintainer's Gmail to detect rejections, interview invites, and recruiter outreach, then mirrors the result to Notion (status update, page comment, or routing to a recruiter-leads log). Reading email at all is a delicate move: it is the highest-trust integration in the pipeline.

Three implementation paths were considered:

1. **Full OAuth client.** Bundle `googleapis`, run an OAuth dance once, persist a refresh token in `profiles/<id>/.gmail-state/`. Standard, works in cron, but stores a long-lived credential on disk and pulls in an SDK with a wide surface.
2. **Gmail push notifications.** Webhook-based, no polling. Requires a public endpoint (or Pub/Sub bridge) and a Google Cloud project per profile. Operationally heavy for a single-maintainer project.
3. **Claude MCP two-phase flow.** The engine writes a batch plan to disk; Claude pulls Gmail through its own MCP session; the engine reads the resulting file and applies side-effects.

By the time `check` was being designed, the maintainer was already running every session inside Claude Code with Gmail MCP wired up. Option 3 added zero new credentials.

## Decision

`check` runs as a two-phase flow with Claude's Gmail MCP as the read path; the engine never holds a Gmail token.

- **`check --prepare`** builds the active-jobs map from the TSV, computes the cursor epoch (last successful check, clamped to 30 days), and writes `profiles/<id>/.gmail-state/check_context.json` plus a printed JSON batch plan (10 companies per batch, plus fixed LinkedIn-alerts and recruiter-outreach batches).
- **Claude session** consumes the batch plan via Gmail MCP and writes `profiles/<id>/.gmail-state/raw_emails.json`.
- **`check --apply`** (or default dry-run) reads `raw_emails.json`, classifies each message, matches it against the active jobs, and applies the planned Notion updates plus TSV writes plus log appends.
- **No Gmail dependency in `package.json`.** No `googleapis`. No OAuth tokens on disk. The only Gmail-shaped state on disk is the batch plan and the resulting raw emails, both gitignored.

## Consequences

Positive:

- Zero secrets at rest for Gmail. A leaked clone of the repo plus the maintainer's `.env` does not give an attacker mailbox access.
- Recovery is trivial: there is no token to refresh, no consent screen to re-pass.
- Code surface is small. `engine/commands/check.js` and a handful of pure modules (`classifier`, `email_matcher`, `email_parsers`, `email_filters`, `email_state`, `email_logs`); each is unit-testable with a JSON fixture.
- Trust model is honest. The Gmail read happens inside the maintainer's own Claude session; nothing in the engine ever sees raw inbox content unless the maintainer pulls it.

Negative:

- `check` requires an interactive Claude session. It cannot run from cron, which means inbox-while-sleeping behavior is not possible today. This is the explicit trade [RFC 005](../../../rfc/005-gmail-cron-autonomous-check.md) reopens.
- The two-phase flow is two commands, not one. The user has to remember to run `--prepare`, hand the plan to Claude, then run `--apply`. The skill (`skills/job-pipeline/SKILL.md`) glues these together when the user invokes the command through Claude, so the friction is mostly a problem when running outside Claude.
- If Claude's MCP shape changes, the batch plan format may need to follow. So far it has been stable.

## References

- [RFC 002](../../../rfc/002-check-command.md) — full design of the two-phase flow (implemented)
- [RFC 005](../../../rfc/005-gmail-cron-autonomous-check.md) — accepted but deferred OAuth/cron path that reopens this trade-off
- [ADR 004](004-fly-vs-launchd.md) — the deployment-side counterpart of the cron question
