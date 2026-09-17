---
name: pipeline-gate
description: Wait for the workflow runs a merge triggers on the base branch (build, deploy, submit) and block until they finish, so downstream work only starts after a change is actually delivered. Use when the user asks to "monitorar o pipeline do PR", "avisar quando o deploy terminar", "esperar o merge e o build", or after merging a PR.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/pipeline-gate.mjs` (Node 22+, no dependencies) is the **post-merge sibling** of the `ci-gate` skill: `ci-gate` watches the PR's own checks *before* the merge, this one watches the workflow runs the **merge commit** starts on the base branch. Run `wait` as a **background** task so the harness wakes you when it exits.

Given a PR it **waits for the merge first** (so you can start it before merging), then reads every workflow run whose `head_sha` is the merge commit, excluding PR-event runs since those belong to `ci-gate`. It finishes only after one extra clean poll, so a workflow that starts another one is still caught.

For a mobile app with no version endpoint to poll, this is often the only external "it shipped" signal: the pipeline run reaching `success` is what tells you the build was produced and submitted. For services that expose a deployed version it complements a version gate: this one answers "did the pipeline finish, and how", a version gate answers "is the new build actually serving".

## Usage

```bash
# Print the pipeline status of a merged PR once.
node scripts/pipeline-gate.mjs current --repo app --pr 583

# Wait for the merge (if still open) and then for the whole pipeline to finish.
node scripts/pipeline-gate.mjs wait --repo app --pr 585
node scripts/pipeline-gate.mjs wait --repo api --ticket ETS-2357     # resolve the PR by head branch == ticket id
node scripts/pipeline-gate.mjs wait --repo admin --branch my-branch

# No PR involved: watch the runs of one commit (a short sha is fine).
node scripts/pipeline-gate.mjs wait --repo api --sha 777eeb0e

# Only one workflow, machine-readable.
node scripts/pipeline-gate.mjs wait --repo app --pr 585 --workflow "Expo" --json
```

## Cancelled runs are not failures by default

Deploy workflows commonly use `concurrency: cancel-in-progress`, so a merge landing while an earlier deploy runs cancels it. That is a takeover, not a failure: the newer run builds a branch tip that already contains the earlier commit. The gate follows the run that took over (the **first** run started after the cancelled one, and the chain if that one is cancelled too) and reports its result, for example `Deploy Dev #391: cancelled, superseded by #396 -> success`. Pass `--strict-cancel` for the literal "cancelled == not green" reading.

## Reference

Target (pick one): `--pr <n>`, `--ticket <KEY>`, `--branch <name>` (head branch), or `--sha <commit>`. Repo: short names `api`/`admin`/`app`/`infra`, or `owner/name` (`--repo`, default from `$E2S_PIPELINE_REPO`). Options: `--workflow <text>` (name substring), `--interval <secs>` (default 30), `--timeout <secs>` (default 3600, `0` = forever, since EAS builds take ~35 min), `--grace <secs>` (how long to wait for the first run to appear, default 180), `--allow-no-runs`, `--strict-cancel`, `--json`.

Exit codes: `0` every run green, `1` a run failed or was cancelled, the PR was closed unmerged, or the push triggered no workflow, `2` usage, `124` timed out.

Pipeline green means the workflow finished, not that every downstream system caught up: a submission step that runs with `--no-wait` still leaves the store processing for minutes after the gate returns.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated.
