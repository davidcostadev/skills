---
name: pending-promotion
description: Show the promotion backlog for one repo or every repo at once - what is on dev but not yet on staging or main - with the ticket, the PRs and each ticket's live Jira status, grouped by repo and by status. Use when the user asks "o que esta em dev e ainda nao em staging/main", "o que falta promover", "what's pending promotion", or before promoting an environment.
metadata:
  author: davidcostadev
  version: "1.0"
---

Two scripts (Node 22+, no dependencies), same rules, different scope:

- `scripts/pending-promotion.mjs` covers **one repo**, one hop.
- `scripts/pending-promotion-all.mjs` covers **several repos** at once, walks the full `dev -> staging -> main` pipeline, and groups the result by repo and by Jira status.

Both read commits straight from git (`git log origin/<to>..origin/<from>`, no checkout and no running service), parse the ticket (`ETS-####`) and PR (`(#NNN)`) out of each commit subject, group commits by ticket, and fetch every ticket's live status in one batched Jira CLI call. Output is Markdown ready to paste, or `--json` for automation. If Jira is unreachable they degrade gracefully, leaving statuses blank instead of failing.

## Usage

```bash
# One repo. Default: dev vs staging, with a staging-vs-main note.
./scripts/pending-promotion.mjs
./scripts/pending-promotion.mjs --repo admin
./scripts/pending-promotion.mjs --to main

# Every repo, full dev -> staging -> main picture.
./scripts/pending-promotion-all.mjs
./scripts/pending-promotion-all.mjs api,admin        # positional list or --repos, both work
./scripts/pending-promotion-all.mjs --to staging     # only the first hop

# Faster / offline / machine-readable.
./scripts/pending-promotion-all.mjs --no-fetch       # skip git fetch, use local refs
./scripts/pending-promotion-all.mjs --no-jira        # skip the Jira status lookup
./scripts/pending-promotion-all.mjs --json
```

Source and target are constrained to the `dev -> staging -> main` order; promoting in reverse is rejected.

## How "already promoted" is decided

This is where naive versions of this report go wrong. A promotion squash-remerges and a hotfix cherry-picks, so the same change lives on each branch under a different sha, and plain ancestry (`staging..dev`) reports every one of them as pending.

Two filters run: `git cherry` patch-ids, plus a normalized-subject match (trailing `(#NNN)` stripped) for the cases patch-id misses. `git cherry` compares without rename detection, so a commit that moves files gets a different id per branch; a cherry-pick taken before a directory reorg touches a different path; a version bump applied over a hotfixed base has a different "from" line. Subject matching is one-to-one (each occurrence on the target vouches for a single pending commit, oldest-first), so a follow-up commit reusing its predecessor's subject stays correctly pending.

## The five sections of the multi-repo report

- **By branch (repo)**: a per-hop table per repo with Ticket, Title, PRs, Jira status.
- **By status**: every distinct ticket rolled up under its status, tagged with the repo(s) it sits in, ordered roughly by closeness to release.
- **Half-promoted across repos**: tickets that reached the final target in one repo but are still pending in another. This is how a full-stack ticket ends up marked Done with only its backend half live in production, and nothing else catches it, because each repo looks internally consistent. Needs at least two repos scanned.
- **Hotfixes**: changes on `staging`/`main` whose ticket never made it back to `dev` (back-merge them or the next promotion reverts them). Skip with `--no-hotfixes`.
- **Behind**: a target branch missing what the branch BELOW it already has (staging behind main), which the hotfix check cannot see because it only compares the targets against `dev`. Shown only when both hops are in range.

A ticket that lives in more than one repo (a coordinated full-stack change) is listed under each repo and appears once in the by-status rollup, tagged with all its repos.

## Reference

Repos: short names or full names (`--repo` / `--repos`, comma-separated, or as a positional). `--from` defaults to `dev`; for the multi-repo script `--to` defaults to `main` (both hops), and `--to staging` limits it to the first hop. Both `git fetch` by default (`--no-fetch` to skip); the `--prune` output is suppressed so the `[deleted] -> origin/...` lines do not leak into the report.

The multi-repo script also saves a timestamped Markdown copy of every run (disable with `--no-report`; `--json` prints to stdout and writes no file). Run `--help` for the full flag list.

## Requirements

Node 22+, `git`, and a Jira CLI reachable for the status lookup (`--no-jira` works without one).
