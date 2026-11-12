# RFC 071 — Morning mail check in the submitter (BL-234)

Status: approved 2026-11-12 (owner: «Включить» on "turn on a daily morning
check of the bot's mailbox, with replies recorded in the base").

## Problem

The nightly bot (RFC 069) applies from the apply mailbox (RFC 068). Replies
land there. The only thing that read them was the fly.io `check --auto`
cron, off since 2026-08-31 with the rest of the automation. On 2026-11-12 a
manual dry run found 9 rejections nobody had recorded, and four "info
requests" that were not employer mail at all (an Amazon payment notice, a
Barnes & Noble rewards mail, a Substack newsletter) — the company matcher
bound them to pipeline rows on a single shared token. An ApartmentIQ
"thanks for applying … if we find that you're a fit, we'll reach out to
schedule an interview" auto-reply classified as an interview invite.

## Options

- A: re-deploy the fly.io cron. Needs a fly login, a second copy of state
  (the TSV lives on the Mac now), and nothing tells the owner about an
  invite except a Notion comment.
- B: run the same check from the Mac submitter, once per morning, right
  after the questions step and before the morning notification.

## Chosen: B

`submit-ready` already runs every 15 minutes from launchd and, once per
date after the submit window closes, runs the questions step and sends the
morning notification. It now also runs `check --auto --apply` in process
(both mailboxes, the existing code path) and:

- appends one line to the morning notification: rejections and invites
  found that morning;
- sends a separate notification "Приглашение на собеседование" listing each
  invite (company and role), whatever the role-match confidence — an invite
  must not be missed because the company had several open rows;
- a failure of the check is logged and never stops the notification.

Fixes that ship with it, so the first run does not write junk:

- non-pipeline senders: Amazon transactional addresses, Barnes & Noble
  marketing (`@t.barnesandnoble.com` only), Substack newsletters;
- classifier: "thanks for applying" plus "if we find/think … schedule an
  interview" in one sentence keeps the ApartmentIQ-style auto-reply an
  acknowledgment. "Thanks for applying" alone is not an acknowledgment: real
  invites open with it.
- the check is capped at 10 minutes; a non-zero exit marks the line
  "(не всё записано в базу)".

## Identity & PII

No new data. The check already writes statuses and comments to the TSV and
Notion; the notification carries company and role only, never email bodies
or addresses.

## Risks

- The first run processes mail back to the last cursor (late May): about
  9 rejections get recorded at once. Expected.
- A check run takes a few minutes (two mailboxes over IMAP); it runs once a
  morning, after the window, so it never delays a submit.

## Verification

Unit tests for the classifier and sender filter on the real cases, a
submit-ready test for the notification line and the invite notification,
and a dry run of `check --auto` on the real mailboxes before the first
morning.
