---
name: api-version-gate
description: Wait until a new API build is actually deployed before starting work that depends on that API change, by polling the deployed /version endpoint. Use when a ticket says "wait for the API deploy", "espera o deploy da API", or when serializing several agents around one deploy.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/api-version-gate.mjs` (Node 22+, no dependencies) blocks until the deployed API reports a build newer than a floor you choose. It reads a `/version` endpoint that serves `service`, `version`, `commit`, `commitShort`, `environment` and `builtAt`. Run `wait` as a **background** task so the harness wakes you when it exits `0`.

## Why time, not commit

Deploys squash-merge, so the PR's own commit SHA never lands on the base branch, and a pipeline can be cancelled by a later merge, so a specific commit may never deploy at all. But any successful deploy built *after* a change merged contains it. So the gate is time-based: it waits until the deployed `builtAt` is later than a floor. The most precise floor is a specific PR's merge time.

## Usage

```bash
# Print the currently deployed version once.
node scripts/api-version-gate.mjs current

# Gate on a specific PR/ticket: wait for it to MERGE, then for a deploy built after
# its merge time. This is the robust "this exact change is live" signal. Branch name
# == ticket id, so --ticket resolves the PR by head branch.
node scripts/api-version-gate.mjs wait --pr 842
node scripts/api-version-gate.mjs wait --ticket ETS-1980

# Generic "next deploy" floors.
node scripts/api-version-gate.mjs wait                       # a deploy built after now
node scripts/api-version-gate.mjs wait --newer-than "$(git show -s --format=%cI origin/dev)"
node scripts/api-version-gate.mjs wait --shared deploy-dev   # several agents share one floor, release together

# Serialize the downstream work across agents (global mutex with a TTL lease).
node scripts/api-version-gate.mjs queue --name admin-mobile -- <build/codegen/...>
```

## Reference

Conditions: `--pr`/`--ticket`, `--newer-than <iso>`, `--shared <key>`, `--commit`, `--version`, `--changed-from`. Endpoint via `--url` or `$E2S_API_VERSION_URL`; repo via `--repo` or `$E2S_API_REPO`. Other flags: `--interval` (default 30s), `--timeout` (default 1800s, `0` = forever), `--json`.

Exit codes: `0` met, `124` timed out (the PR never merged, the deploy never landed, or the queue turn never came), `2` usage, otherwise the queued command's own code.

Locks and floors live under the OS temp dir, so concurrent agents coordinate automatically without any setup. Run `--help` for the full reference.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated for the `--pr`/`--ticket` conditions. The `/version` endpoint must be reachable.
