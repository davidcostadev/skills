---
name: release-notes
description: Generate release notes for a PR, one line per ticket with every PR that delivered it, and optionally write them into the PR body. Nets out reverts so work held out of a release is not reported as shipped. Use when the user asks to "gerar release notes", "criar as notas do PR de deploy", "o que entra nesta release", or before merging a deploy PR.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/release-notes.mjs` (Node 22+, no dependencies) produces release notes for a PR, one line per ticket. It works retroactively on already-merged PRs (squash or merge-commit), and on any commit range with no PR at all.

Output format, where a ticket delivered by several PRs lists each of them, newest first:

```text
- ETS-2292: #874 (10224126) / #870 (0d7ca178)
- ETS-2359: #1097 (60938655)
```

**Never wrap the ticket id in brackets.** `- [ETS-2359]: #1097 (60938655)` is valid CommonMark for a link reference definition (`[label]: destination (title)`), so GitHub swallows the whole line and renders an **empty bullet**. Entries with two or more PRs escape it, because the trailing ` / #870 (0d7ca178)` breaks the definition syntax, which is what made the bug look intermittent instead of obvious. A bare `ETS-1234` is still clickable anyway: GitHub's Jira autolink turns it into a link on its own, with no markdown involved.

## Usage

```bash
# Print the notes for a PR (dry-run, changes nothing).
./scripts/release-notes.mjs --repo api --pr 1098

# Write them into the PR body.
./scripts/release-notes.mjs --repo admin --pr 902 --apply

# Retroactive: works on merged PRs too, squash or merge-commit.
./scripts/release-notes.mjs --repo api --pr 1065

# Any range, no PR needed.
./scripts/release-notes.mjs --repo app --from origin/main --to origin/staging
./scripts/release-notes.mjs --repo infra --pr 137 --json
```

## How it reads commits

It parses `git log` subjects locally (`ETS-1234: title (#567)`), never `gh`'s `messageHeadline`, because that field truncates at ~70 chars and eats the trailing `(#567)`. Merge commits are excluded (`--no-merges`): a `hotfix:` or `Deploy on ...` commit is the vehicle, not the work, so the per-ticket commits underneath are reported instead. A commit that reached the branch via a merge commit has no `(#567)` in its subject; for those it falls back to `repos/.../commits/<sha>/pulls` and takes the **lowest** PR number, since higher ones are the hotfix or deploy PRs that carried it onward. Multi-ticket subjects (`ETS-1 / ETS-2: title`) list the PR under each ticket. Commits with no ticket are skipped and reported on stderr.

## Reverts are netted out

A ticket held out of a release is reverted before the cut, and its original commits stay in the range, so listing every ticket found in a subject reported held-out work as shipped on the deploy PR of the very release that excluded it.

A ticket whose deliveries are all reverted inside the range moves to a **Held out of this release** section (`- ETS-2414: #1278 (4e5c4e6e), reverted by #1285 (e303fddf)`); a range that only removes code gets **Rolled back in this release**. A revert followed by a reapply, both landing in a range that spans a cut, still counts as delivered, which is why the commits are replayed oldest-first instead of counted. One revert PR undoes however many PRs a ticket had, so a revert clears every earlier delivery of that ticket rather than cancelling one.

Both sections sit **inside** the marker block on purpose: written by hand outside it they go stale on the next `--apply`, which is exactly when they matter most.

## Reference

`--apply` wraps the notes in `<!-- release-notes:start -->` / `<!-- release-notes:end -->` markers, so re-running updates them in place and never duplicates the block or clobbers the rest of the body. A merged PR's range is recovered from its merge commit's parents, so it does not depend on the head branch still existing. Dry-run by default; `--apply` refuses to write an empty block.

Other flags: `--title`, `--json`, `--no-fetch`, and the `$E2S_RELEASE_NOTES_REPO` / `$E2S_GH_OWNER` env vars. Run `--help` for the full list.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated.
