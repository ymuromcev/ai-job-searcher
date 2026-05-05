# ADR 004 — Local-only operation under launchd, no cloud host

- Status: rejected (for now)
- Decided: 2026-05-05
- Related: [RFC 005](../../../rfc/005-gmail-cron-autonomous-check.md)

## Context

With [RFC 005](../../../rfc/005-gmail-cron-autonomous-check.md) accepted but deferred, the question of where the autonomous `check` cron should eventually run came up. The pipeline is small (a single Node process per profile, each invocation lasting under a minute) but it touches several credentials per run: a Notion token, a Gmail token, optional ATS keys. A serverful deployment was tempting because it would let `check` actually run while the maintainer sleeps, which was the original motivation.

Three hosting options were on the table:

1. **Fly.io** with a per-profile machine and secrets in Fly's secret store.
2. **Railway** or an equivalent PaaS with Node-native job runners.
3. **Local-only** under macOS launchd, scheduling a `check --apply` per profile on the maintainer's laptop.

Two specific factors pushed the decision toward local-only at this point in the project:

- The current `check` flow is bound to a Claude MCP session for Gmail reads (see [ADR 003](003-mcp-vs-oauth.md)). Running it on a remote host would not actually unlock overnight checks until RFC 005's OAuth-based read path is implemented; until then a cloud host adds cost without buying autonomy.
- The per-profile secret matrix is non-trivial — three to five env vars per profile, growing — and a cloud secret store would need to mirror the namespacing rules the engine already enforces locally.

## Decision

Defer cloud deployment. Operate the engine locally on the maintainer's macOS machine, with launchd handling any scheduled tasks once they exist (currently none — `check` is interactive).

- No Fly, Railway, or equivalent hosting is provisioned.
- Secrets remain in the root `.env` on the maintainer's machine, gitignored.
- Once RFC 005's OAuth path lands, an autonomous `check` will run via a launchd plist (one per profile) reading from the same `.env`. No cloud surface is opened in the interim.
- The decision is explicitly time-boxed: it is "rejected for now," not "rejected forever."

## Consequences

Positive:

- Zero hosting cost. The pipeline fits inside whatever Claude session is already open and the laptop that is already running.
- Secrets never leave the maintainer's machine. There is no cloud blast radius to worry about; revocation is a single `.env` edit.
- Debugging is direct. A misbehaving cron is just a log file in the maintainer's home directory; there is no remote shell to attach to.
- Migration to a cloud host later is straightforward — the engine is already a single Node command with an `.env`-based config, and the per-profile `--profile` flag maps cleanly onto per-profile cloud apps if that day comes.

Negative:

- No autonomous overnight checks until RFC 005's OAuth path lands. The `check` command remains tied to a live Claude session.
- Single point of failure. If the laptop is closed, asleep, or offline, no part of the pipeline runs. For a single-maintainer project this is acceptable; for any team or paid-user scenario it would not be.
- launchd has its own quirks (network availability at wake-from-sleep, environment loading) that have to be solved per-machine. Mitigated by keeping any scheduled job a thin wrapper around the existing CLI commands.

## Re-open trigger

This ADR should be revisited when both of these become true:

1. RFC 005 is implemented — `check` no longer requires an interactive Claude session.
2. A third profile is onboarded onto the engine. At that scale the per-profile launchd matrix on a single laptop starts to feel like a workaround rather than a deliberate choice.

## References

- [RFC 005](../../../rfc/005-gmail-cron-autonomous-check.md) — accepted, deferred; the load-bearing prerequisite
- [ADR 003](003-mcp-vs-oauth.md) — Gmail-via-MCP, which is why a cloud host buys nothing today
- [ADR 001](001-multi-profile.md) — per-profile isolation, which any future cloud topology must preserve
