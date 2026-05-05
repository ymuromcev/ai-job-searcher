# Personas

> **Status**: stub (RFC 018 phase 1). Full anonymized personas drafted in phase 2.

The repo runs against two real candidates whose names and personal data live only in gitignored `private/personas-real.md`. Public docs refer to them by anonymized aliases:

| Alias | Profile id | Domain | Geography |
|---|---|---|---|
| **PM-Pete** | `jared` | Senior AI / Product Management, fintech-leaning | US-wide, remote/hybrid |
| **Healthcare-Hannah** | `lilia` | Healthcare admin, manual + clinical roles | Sacramento, CA local |

Detailed persona narratives (background, goals, frustrations, success criteria) are drafted in phase 2 of [RFC 018](../../rfc/018-documentation-system.md).

## Why anonymized

Public repo policy (RFC 018 §15 + pre-commit hook): real names never appear in tracked files. The aliases preserve domain context so reviewers can reason about why specific design decisions exist (e.g., "Healthcare-Hannah needs Indeed coverage because GH/Lever/Ashby don't index regional clinics").
