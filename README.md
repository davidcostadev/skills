# skills

Personal Claude Code skills, one folder per skill.

## Skills

| Skill | Type | Description |
| --- | --- | --- |
| [llm-council](llm-council/SKILL.md) | user | Pressure-test a decision through a council of 5 independent Claude advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) with anonymous peer review and a chairman synthesis. Claude-only adaptation of Karpathy's LLM Council. |
| [save-session](save-session/SKILL.md) | user | Summarize the current conversation and save it as a structured markdown file in `~/.claude/chats/`. Captures decisions, files touched, key commands, and session metadata. |
| [handoff](handoff/SKILL.md) | user | Compact the current conversation into a handoff document for another agent to pick up. |
| [pr-review](pr-review/SKILL.md) | user or project | Review a PR, branch, or uncommitted working-tree diff CodeRabbit-style. Runs the bundled diff-scoped static analyzer (`scripts/pr-review.mjs`) against the current git repo (or any repo via `--repo <path>`), then writes a structured review with findings grouped by severity. |

### Gates: wait for something, then act

Each one is meant to run as a **background** task, so it wakes the agent with a real exit code instead of being polled.

| Skill | Type | Description |
| --- | --- | --- |
| [ci-gate](ci-gate/SKILL.md) | user or project | Wait until a PR's CI finishes; exit 0 if all green, 1 if red, 3 with `--coderabbit` when a review finding is still unanswered. Keys on the head SHA and keeps only each check's latest attempt, so it never reports a stale run. |
| [pipeline-gate](pipeline-gate/SKILL.md) | user or project | The post-merge sibling: waits for the merge, then for the workflow runs the merge commit triggers on the base branch. Follows a run that was cancelled by a later merge to the run that took over. |
| [api-version-gate](api-version-gate/SKILL.md) | user or project | Wait until a new API build is actually serving, by polling a `/version` endpoint. Time-based (`builtAt` after a floor), because a squash-merged commit SHA may never deploy. |
| [admin-version-gate](admin-version-gate/SKILL.md) | user or project | The frontend counterpart: same rationale, reading the static `build-info.json` a build emits instead of an HTTP version endpoint. |
| [notify](notify/SKILL.md) | user | Send a Telegram message, or wrap any long command so a ping fires the moment it exits, with exit code, duration and the failure tail. The callback layer for the gates above. |

### Release and promotion

| Skill | Type | Description |
| --- | --- | --- |
| [pending-promotion](pending-promotion/SKILL.md) | user or project | What is on `dev` but not yet on `staging`/`main`, for one repo or all of them, with the tickets, PRs and live Jira statuses. Decides "already promoted" by patch-id and subject match, not ancestry, so squash-remerges and cherry-picks are not reported as pending. |
| [release-notes](release-notes/SKILL.md) | user or project | Release notes for a PR, one line per ticket listing every PR that delivered it. Nets out reverts, so work held out of a release is not reported as shipped. |
| [title-pr-improve](title-pr-improve/SKILL.md) | user or project | Normalize open PR titles: drop the leading area marker, lowercase the first letter after the ticket id. A title still too long is reported, never auto-edited. |
| [cleanup-worktrees](cleanup-worktrees/SKILL.md) | user or project | Remove git worktrees whose branch has a merged PR, across several repos. Handles the Windows failure mode where git deregisters the worktree but cannot delete the directory, leaving an orphan nothing reports again. |

### Diagnostics

| Skill | Type | Description |
| --- | --- | --- |
| [gql-breaking-check](gql-breaking-check/SKILL.md) | user or project | Detect GraphQL breaking changes and consumer drift across environment branches, reading every branch via `git show` with no checkout and no running API. Also validates each promotion hop before you make it. |
| [gql-log-analysis](gql-log-analysis/SKILL.md) | user or project | The heaviest and most frequent GraphQL operations from API logs: p50/p95/p99, where total server time goes, heaviest mutations, error rates. Autodetects four log shapes. |
| [frd-serve](frd-serve/SKILL.md) | user or project | Render a directory of markdown docs as a browsable site (HTTP server or static build). Dependency-free renderer that preserves deep nested lists instead of flattening them. |

## Installation

Every skill folder is self-contained. Install user-wide in `~/.claude/skills/<name>/` (available in every project) or per project in `<project>/.claude/skills/<name>/`. Either symlink (edits stay versioned in this clone) or copy:

```bash
git clone git@github.com:davidcostadev/skills.git ~/workspace/skills

# Symlink (recommended)
ln -s ~/workspace/skills/llm-council ~/.claude/skills/llm-council

# Or copy
cp -r ~/workspace/skills/llm-council ~/.claude/skills/
```

## Requirements

- `llm-council`, `save-session`, `handoff`: no external dependencies, SKILL.md only.
- `pr-review`: Node 22+. eslint, prettier and tsc come from the target repo's own devDependencies (invoked with `npx --no-install`); the duplication check fetches `jscpd@4` on demand via `npx --yes`. PR mode and `--post` need the `gh` CLI.
- `ci-gate`, `pipeline-gate`, `title-pr-improve`, `cleanup-worktrees`, `release-notes`: Node 22+, `git`, and the `gh` CLI authenticated.
- `api-version-gate`, `admin-version-gate`: Node 22+, plus `gh` for the `--pr`/`--ticket` conditions. The deployed `/version` or `build-info.json` URL must be reachable.
- `notify`: Node 22+. Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from the environment (falling back to a bot `.env`), so no token is ever passed on a command line.
- `pending-promotion`: Node 22+ and `git`. The live status column needs a Jira CLI reachable; `--no-jira` works without one.
- `gql-breaking-check`: Node 22+ and `git`. Reuses the GraphQL libraries already installed in the consumer repo's `node_modules` rather than adding dependencies.
- `gql-log-analysis`: Node 22+. The `--env` mode needs the `aws` CLI with credentials; piping or passing files needs nothing.
- `frd-serve`: Node 22+. Nothing else.

## A note on defaults

The gates, promotion and diagnostics skills were written for a specific multi-repo setup and still carry its defaults: repo short names (`api`/`admin`/`app`/`infra`), deployed URLs, log group names and an `ETS-####` ticket pattern. Every one of those is overridable by a flag or an env var, documented in each SKILL.md, but expect to pass them (or edit the constants at the top of the script) before the first useful run elsewhere.
