---
name: ci-gate
description: Wait until a pull request's CI finishes, then exit 0 if every check is green or 1 if anything failed, so downstream work (merge, promote, a "fixed" comment, a follow-up ticket) only runs once CI is actually green. Optionally also require CodeRabbit's findings to be answered. Use when the user says "wait for CI", "espera o CI passar", "monitorar se o CI passa", after pushing a fix, or before merging or promoting.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/ci-gate.mjs` (Node 22+, no dependencies) blocks until a PR's CI completes and reports the verdict as an exit code. Run `wait` as a **background** task: the harness wakes you when it exits, with a code you can branch on.

It reads the PR's **head-commit** check rollup through the `gh` CLI (`gh pr view --json statusCheckRollup`), collapsing each check to its latest attempt, so it always tracks the CURRENT run. Right after a push it sees the new run's checks, never a stale previous one, and if the head moves mid-wait it re-targets automatically. `gh auth login` must already be done.

## Use this instead of a hand-rolled poll loop

Ad-hoc `gh pr checks` loops get four things wrong that this script already handles:

1. They read the **previous** run's results in the seconds right after a push. This script keys on the PR head SHA.
2. They count **every attempt** of a check that ran twice on one commit, stale one included, and report a red PR that is actually green. This script keeps only each check's latest attempt, keyed on workflow + name.
3. They treat silence, `skipping` and `cancelled` inconsistently. Here `pass`/`skipping` are green, `fail`/`cancel` are red, `pending` keeps waiting.
4. They lack real exit codes.

## Usage

```bash
# Print a PR's CI status once (exit 0 only if complete and all green).
node scripts/ci-gate.mjs current --repo api --pr 1039

# Wait until CI finishes; exit 0 = all green, 1 = something failed or was cancelled.
node scripts/ci-gate.mjs wait --repo api --pr 1039
node scripts/ci-gate.mjs wait --repo admin --ticket ETS-2161      # resolve the PR by head branch == ticket id
node scripts/ci-gate.mjs wait --repo app --branch my-branch

# Gate on a subset of checks only (ignore the rest).
node scripts/ci-gate.mjs wait --repo api --pr 1039 --required build,unit-tests-result

# Also require CodeRabbit's findings to be answered (exit 3 if any is not).
node scripts/ci-gate.mjs wait --repo api --pr 1039 --coderabbit
```

## `--coderabbit`: "CI is green" is not "the PR is ready"

The `CodeRabbit` entry in the check rollup only reports that the bot finished. It is green even when the review left findings, so a PR can show all checks passing while still owing the reviewer answers. This flag reads the review threads themselves (GraphQL, because `isResolved` is not in the REST payload) and exits **3** when any CodeRabbit finding has no human reply. Use it whenever the next step depends on the PR being genuinely done.

Two decisions worth knowing:

- **A thread you answered stops gating**, even if still open. The reply is the deliverable: CodeRabbit learns from it, which is what keeps the finding from coming back on every future PR. Whether the thread is then resolved in the UI is a human's call, so gating on it would leave the gate permanently red on every finding anyone declined.
- **Not filtered to the head commit.** A finding raised two pushes ago is still owed an answer.

Exit `3` is separate from `1` on purpose: a red build and an unanswered reviewer need different work, so an agent branches on the code instead of parsing output. Threads are only read once CI is green, because a broken build is what you fix first.

## Reference

Target (pick one): `--pr <n>`, `--ticket <KEY>` (branch name == ticket id), or `--branch <name>`. Repo: short names `api`/`admin`/`app`/`infra`, or `owner/name` (`--repo`, default from `$E2S_CI_REPO`; owner from `$E2S_GH_OWNER`). Options: `--required <a,b>`, `--coderabbit`, `--interval <secs>` (default 30), `--timeout <secs>` (default 1800, `0` = forever), `--json`.

Exit codes: `0` complete and all green (and, with `--coderabbit`, every finding answered), `1` complete but red, `2` usage, `3` green but CodeRabbit has unanswered findings, `124` timed out.

After the merge, the `pipeline-gate` skill takes over and watches the runs the merge itself triggers.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated.
