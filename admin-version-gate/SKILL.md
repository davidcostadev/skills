---
name: admin-version-gate
description: Wait until a new frontend build is actually deployed, by polling the static build-info.json the build emits, so downstream work (mobile, QA verification, a follow-up ticket, a "fixed" comment) only starts once the frontend part is shipped. Use when a ticket says "wait for the admin deploy", "espera o deploy do admin", or "monitor when we ship the admin part".
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/admin-version-gate.mjs` (Node 22+, no dependencies) is the frontend counterpart of the `api-version-gate` skill. Same commands, flags, exit codes and time-based rationale: a deploy built *after* a change merged contains it, which is a robust signal where a squash-merged commit SHA is not. Run `wait` as a **background** task.

Instead of an HTTP version endpoint it reads the static `public/build-info.json` that the build regenerates (`{ commit, builtAt }`), the same file an app can poll to surface "update available". The request appends a cache-buster so a CDN never serves a stale copy while polling.

## Usage

```bash
# Print the currently deployed build once.
node scripts/admin-version-gate.mjs current

# Gate on a specific PR/ticket: wait for it to MERGE, then for a deploy built after
# its merge time. Branch name == ticket id, so --ticket resolves the PR by head branch.
node scripts/admin-version-gate.mjs wait --pr 711
node scripts/admin-version-gate.mjs wait --ticket ETS-2021

# Generic "next deploy" floors.
node scripts/admin-version-gate.mjs wait                       # a deploy built after now
node scripts/admin-version-gate.mjs wait --shared deploy-dev   # several agents share one floor

# Serialize downstream work across agents (global mutex with a TTL lease).
node scripts/admin-version-gate.mjs queue --name admin-ship -- <verify/comment/...>
```

## Reference

Conditions: `--pr`/`--ticket`, `--newer-than <iso>`, `--shared <key>`, `--commit`, `--changed-from`. There is no `--version`, because `build-info.json` exposes only `commit` and `builtAt`. URL via `--url` or `$E2S_ADMIN_VERSION_URL`; repo via `--repo` or `$E2S_ADMIN_REPO`. Same `--interval` / `--timeout` / `--json` and the same exit codes as the API gate: `0` met, `124` timed out, `2` usage, otherwise the queued command's own code.

Run `--help` for the full reference.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated for the `--pr`/`--ticket` conditions. The `build-info.json` URL must be reachable.
