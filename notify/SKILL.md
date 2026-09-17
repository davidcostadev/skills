---
name: notify
description: Send a Telegram message, or wrap any long-running command so you are pinged on your phone the moment it finishes, with its exit code, duration and failure tail. Use whenever the user asks to be notified, avisado or pinged, asks for a callback when something finishes, or asks to monitor a gate.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/notify.mjs` (Node 22+, no dependencies) sends a Telegram message, and, the main use, **wraps any long-running command** so a ping fires the moment it exits. It is the callback layer for background gates: the agent starts the gate in the background, and the result arrives on the phone instead of in a terminal nobody is watching.

Wrapping is the default shape. Do not send a manual "done" message after the fact: wrap the command so the ping fires even if the session is idle.

## Standalone

```bash
# Plain message, or a report piped in.
node scripts/notify.mjs "ETS-2418 merged, promoting to staging"
./some-report.mjs | node scripts/notify.mjs --title "Promotion backlog" --stdin

# Wrap any long command, gate or not. Run it as a BACKGROUND task.
node scripts/notify.mjs --title "E2E suite" -- pnpm test:e2e --branch ETS-2468
```

## Together with the gates

```bash
# 1. One gate, one ping.
node scripts/notify.mjs --title "CI api#1039" -- node scripts/ci-gate.mjs wait --repo api --pr 1039

# 2. Full chain around a PR. Every gate waits for the merge on its own, so all three
#    can start AT THE SAME TIME as separate background tasks. They do not need to be
#    sequenced, and each pings as its own stage lands.
node scripts/notify.mjs --title "CI app#585"       -- node scripts/ci-gate.mjs wait --repo app --pr 585
node scripts/notify.mjs --title "Pipeline app#585" -- node scripts/pipeline-gate.mjs wait --repo app --pr 585
node scripts/notify.mjs --title "Admin live"       -- node scripts/admin-version-gate.mjs wait --pr 711

# 3. SELECTIVE: watch an early stage silently, ping only at a later one. This is the
#    common ask ("check CI but only ping me when it is live"): run the early gate BARE
#    (no wrapper) and report it in-session, wrap only the stage they asked about.
node scripts/ci-gate.mjs wait --repo admin --pr 968                                    # bare, no ping
node scripts/notify.mjs --title "Admin live" -- node scripts/admin-version-gate.mjs wait --pr 968

# 4. GATE -> ACTION -> PING: when the ping must come AFTER work they asked for (move the
#    ticket, promote, comment), do NOT wrap the gate. Run it bare in the background, let
#    the harness wake you on exit 0, do the work yourself so a failure is visible, then
#    send ONE ping describing the whole outcome.
node scripts/admin-version-gate.mjs wait --pr 968     # background; the harness wakes you
pnpm jira update ETS-2468 --status "QA Ready"
node scripts/notify.mjs --title "ETS-2468 live" "Deploy live, handed over, QA Ready."

# 5. Noisy loop: ping only when something breaks.
node scripts/notify.mjs --only-fail --title "CI dev" -- node scripts/ci-gate.mjs wait --repo api --branch dev
```

**Pick the shape by who acts on the result.** If the ping IS the deliverable, wrap the gate (shapes 1-3). If work must happen between the gate and the ping (shape 4), keep them separate: wrapping would ping before the work is done, and burying `&&`-chained writes inside a background task hides their failure.

**One ping per stage they asked about, not per command.** Three gates on one PR are three pings, because they are three distinct events; a gate plus its follow-up work is one.

## What wrap mode does

It keeps the command's output on the terminal, buffers the last lines, and sends emoji + exit code + duration, with the tail in a `<pre>` block when it failed, so the ping says *why*. It **exits with the wrapped command's own exit code**, so it composes with everything and the harness still wakes the agent with a real result. A Telegram failure is logged but never rewrites that exit code. Exit codes are read with the gate convention: `0` ok, `1` failed, `2` usage error, `124` timeout.

**Every notification carries the PR and the ticket as links**, because a ping you cannot tap is a dead end on a phone. In wrap mode they are **sniffed from the wrapped command** (`--pr`, `--repo`, `--ticket`, or `--branch`, since branch name == ticket id), and the repo falls back to the gate's own default, so wrapping a gate needs no extra flags. In message mode pass `--pr admin#968` / `--ticket ETS-2468` (the ticket is also picked up from the `--title`). `--no-links` opts out.

## Reference

Options: `--pr <ref>` / `--ticket <KEY>` / `--repo <name>` / `--no-links`, `--title <t>` (bold first line, defaults to the command), `--only-fail` (ping only when it does not exit 0, for noisy loops), `--tail <n>` / `--no-tail` (failure context, default 15 lines), `--silent` (no sound), `--chat-id <id>`, `--raw-html`, `--stdin`, `--dry-run`. Run `--help` for the full reference.

## Requirements

Node 22+. Credentials come from `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, read from the environment, falling back to a bot `.env`, so no token is ever passed on a command line. The Jira base URL for ticket links comes from `$JIRA_BASE_URL`.
