---
name: pr-review
description: Review a PR, branch, or uncommitted working-tree diff CodeRabbit-style - run the diff-scoped static analyzer (scripts/pr-review.mjs), then write a structured review with findings grouped by severity (file:line + a suggested fix) and one consolidated "Prompt for AI Agents" block that lists the fix for every comment. No walkthrough. Use when the user says "revisar PR", "review this PR/diff", "review my current work", "code review estilo coderabbit", or runs /pr-review.
metadata:
  author: davidcostadev
  version: "1.1"
---

Review a pull request (or a branch diff) and produce a CodeRabbit-style review.

There are two layers:
- **The script** (`scripts/pr-review.mjs`, bundled next to this SKILL.md) is the objective layer - complexity, duplication, eslint, prettier and tsc, scoped to the changed lines. It writes `report.json` + `summary.md`. Run it; do not redo its work by hand.
- **This skill** is the judgment layer - read the script output plus the raw diff, add the things a static tool cannot see (logic bugs, edge cases, races, missing tests, naming, design), and write `review.md`.

## CRITICAL: write everything in simple English

Every word you write in the review - finding explanations and the "Prompt for AI Agents" block - MUST be simple English:
- Short, direct sentences. One idea per sentence.
- Common words. Active voice ("This drops the error" not "The error is dropped").
- No jargon unless it is a real code term. No filler, no flourish.
- Goal: any developer, including non-native speakers, reads it fast and acts on it.

Also: artifacts in **English**, **straight quotes** only (`"` `'`, never curly), and **no AI attribution** anywhere (no "Generated with Claude", no bot signature).

## Input

The trigger carries the target, e.g.:
- `/pr-review 770` - PR `770` of the current repo
- `/pr-review --base origin/main` - branch diff vs `origin/main` (default base is origin's default branch)
- `/pr-review --repo ../other-repo 42` - PR `42` of another local repo (a path)
- `/pr-review --working-tree` - uncommitted work (staged + unstaged + new files vs HEAD), no PR or base needed - fits a pre-commit self-review
- `/pr-review --staged` - only the staged changes vs HEAD
- add `--post` to publish inline comments on the GitHub PR (otherwise local only)

`--working-tree` and `--staged` review local uncommitted work, so there is no PR to post to: ignore `--post` in those modes and just write `review.md` locally.

If the target is ambiguous (e.g. a bare number that may not be a PR), ask once with AskUserQuestion. Do not guess a PR number.

## Steps

### 1. Run the analyzer

Build the command from the args (the script lives at `scripts/pr-review.mjs` inside this skill's directory):

```bash
node <skill-dir>/scripts/pr-review.mjs [--repo <path>] [--pr <n> | --base <ref> | --working-tree | --staged] --json
```

The script also wrote `report.json` + `summary.md` to `<tmpdir>/pr-reviews/<repo>-<id>/` (it prints the exact path; override with `--out`), where `<id>` is `pr-<n>`, `branch-<branch>`, `worktree-<branch>`, or `staged-<branch>` depending on the mode. Read `report.json` from there (it tells you `repoDir`, `target`, `files[]`, `findings[]`, `totals`, `notes`). If `notes` lists a skipped or failed tool (e.g. eslint could not run because a worktree has no `node_modules`), mention it in the review so the gap is visible.

### 2. Read the diff and the code

- Get the raw diff for context:
  - PR: `gh pr diff <n>` (run inside `repoDir`)
  - branch: `git -C <repoDir> diff <base>...HEAD`
  - working-tree: `git -C <repoDir> diff HEAD` plus new files via `git -C <repoDir> ls-files --others --exclude-standard`
  - staged: `git -C <repoDir> diff --cached`
- Open the changed files (or hunks) that matter so your judgment findings are grounded in the real code, not guessed.
- Cross-check: if `--pr` was used, confirm the PR head branch is what is checked out in `repoDir`; the script warns when it is not. Static metrics reflect the working tree.

### 3. Write `review.md`

Write it to the same report dir the script printed: `<tmpdir>/pr-reviews/<repo>-<id>/review.md`. Use this shape:

Do NOT write a walkthrough or a change summary - CodeRabbit already posts one, so it is just noise. Start at the findings. Use this shape:

````markdown
# Review: <repo> - <target>

<Optional single line, e.g. "No high-severity bugs found.">

## Findings

### 🔴 Potential issue - `path/to/file.ts:42`

<What is wrong, in 1-2 simple sentences. Then why it matters.>

```suggestion
// the corrected lines (only when you can give a concrete fix)
```

### 🟡 Refactor suggestion - `path/to/other.ts:88`
...

### 🔵 Nitpick - `path/to/x.ts:10`
...

## 🤖 Prompt for AI Agents

```
Apply these fixes to <repo> PR #<n>:

1. path/to/file.ts:42 - <plain-English instruction: what to change and what "done" looks like; mention the test or edge case if relevant>.
2. path/to/other.ts:88 - <...>.
3. path/to/x.ts:10 - <...>.
```
````

Rules for findings:
- No walkthrough. No file-change table. Findings first.
- **Merge** the script's objective findings (each has `tool`, `severity`, `file`, `line`, `rule`, `message`) with your own judgment findings. Do not just restate the script; explain the real impact.
- **Severity**: 🔴 = a real bug, data loss, security or broken behavior. 🟡 = should refactor (complexity, duplication, design, missing test). 🔵 = nitpick (style, naming, formatting). When unsure between two, pick the lower one.
- Every finding has a `file:line` and, when you can, a concrete `suggestion` block.
- **Always end with one consolidated "🤖 Prompt for AI Agents" block** - a single fenced code block that lists the fix for every comment, numbered, each with `file:line` and a plain-English instruction. This is the main deliverable: a developer pastes the whole block into an agent to fix all the comments at once. Cover every finding above, in the same order.
- If the diff is clean, say so plainly and list any low-value nitpicks under 🔵 (or none). If there is nothing to fix, skip the consolidated prompt.
- Do not invent line numbers. If you are not sure of a line, point at the function or hunk instead.

### 4. Deliver

Default (no `--post`): write `review.md`, then print it (or a short index of findings + the path) to the user. Do not touch GitHub.

With `--post` (PR mode only): publish inline comments on the GitHub PR. **Confirm with the user before posting** (show how many comments and their severity). Then use the GitHub API with a JSON file - `gh pr review` cannot attach inline comments.

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)   # run inside repoDir
SHA=$(gh pr view <n> --json headRefOid --jq .headRefOid)
```

Write `/tmp/pr-review-payload.json`:
```json
{
  "commit_id": "<SHA>",
  "event": "COMMENT",
  "body": "## 🤖 Prompt for AI Agents\n\n```\n<the consolidated all-comments prompt, simple English, no AI attribution>\n```",
  "comments": [
    { "path": "src/file.ts", "line": 42, "body": "🔴 <finding + a `suggestion` block when you have a one-line fix>" }
  ]
}
```
- **No walkthrough in the body.** The review `body` carries the consolidated "🤖 Prompt for AI Agents" block (the fix list for every inline comment). Each inline comment holds its own finding + suggestion.
- `line` is the line in the file at the PR head (right side of the diff). For a range, add `start_line` next to `line`.
- Only post comments on lines that are part of the diff, or GitHub rejects the whole review. Re-anchor a finding (e.g. a duplication or complexity hit on an unchanged line) to the nearest changed line in that file, and say so in the comment.
- A committable `suggestion` block must replace the commented line exactly (same indentation). Only use one when your fix is a single-line, drop-in replacement.
- Use `"event": "COMMENT"` (neutral). Use `"REQUEST_CHANGES"` only if the user asks.
- Build the payload with a small Node script (`JSON.stringify`) so newlines, quotes, and backticks escape correctly.

Submit:
```bash
gh api repos/$REPO/pulls/<n>/reviews --method POST --input /tmp/pr-review-payload.json
```

After posting, give the user the PR review URL.

## Notes

- The report dir lives under the OS temp dir (`<tmpdir>/pr-reviews/...`), outside the repo, so nothing dirties the working tree.
- Static tools read the working tree. For an accurate review, work from the branch's worktree (or check it out) so the code on disk matches the diff.
- Toggles to pass through when asked: `--no-types` (skip the slow tsc pass), `--all-findings` (report everything in the changed files, not only the changed lines), `--ccn <n>` (complexity threshold).
