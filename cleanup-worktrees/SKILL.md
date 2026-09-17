---
name: cleanup-worktrees
description: Remove git worktrees whose branch has a merged PR on GitHub, across several repos at once, and clean up the orphan directories a failed removal leaves behind on Windows. Use when the user asks to "limpar worktrees", "remover worktrees mergeados", or after a batch of PRs lands.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/cleanup-worktrees.mjs` (Node 22+, no dependencies) walks a directory holding several sibling repo checkouts, and for each worktree whose branch has a merged PR it runs `git worktree remove` and then `git branch -d`. It runs the same on Windows and Linux. The root is derived from the script's own location, so nothing is hardcoded, and the working directory does not matter.

## Usage

```bash
# Dry-run. Lists what would be removed, changes nothing.
./scripts/cleanup-worktrees.mjs

# Actually remove worktrees and delete their local branches.
./scripts/cleanup-worktrees.mjs --apply

# Limit to one or more repos (short or full names, comma-separated).
./scripts/cleanup-worktrees.mjs --repo api --apply
./scripts/cleanup-worktrees.mjs --repo api,app

# Another root ($E2S_ROOT also works) / machine-readable.
./scripts/cleanup-worktrees.mjs --root /path/to/root
./scripts/cleanup-worktrees.mjs --json

# Windows: also delete directories git could not (locked node_modules) and the
# orphans a previous failed removal left behind.
./scripts/cleanup-worktrees.mjs --apply --purge-ignored
```

PowerShell does not honour the `#!` line, so invoke it through `node` there; Git Bash and WSL run it directly.

## `--purge-ignored` and orphan directories: the Windows failure mode

`git worktree remove` deletes the whole directory, ignored files (`node_modules`, `.env`, `dist`) included. On Windows it regularly fails at that last step with `Directory not empty` / `failed to delete`, because a file is locked (a watcher, a test run, an editor, an antivirus) or a path is too long. The damaging part is what git does next: **it deregisters the worktree anyway**, so the directory survives with no `.git`, invisible to `git worktree list` and therefore to any later run of this script. Nothing ever reports it again.

So the flag does two things: it finishes a removal that failed inside the same run, and it scans the root for `<repo>_*` directories that carry no `.git` and are registered nowhere, reporting them as `ORPHAN` (always) and deleting them (with `--apply`). Without the flag an orphan is still reported, so the cleanup never silently leaves junk behind. The `.git` check is what keeps a live checkout safe. Deletion is Node's own `fs.rm`, which handles the >260-char paths git chokes on; a locked file yields `purge failed: EBUSY`, counted in `removal failed` (exit `1`) and retried on the next run. Any purged `.env` / `*.pem` / `*.key` is named in the output, because git cannot bring those back.

**On Windows `--apply --purge-ignored` is the normal form, not the escape hatch.** A plain `--apply` succeeds on Linux and routinely leaves orphans on Windows, for the reason above.

**Check nothing is running inside the worktree first.** A test run or dev server holds handles on the directory, which is what makes the deletion fail, and a purge that runs anyway deletes files out from under it. `EBUSY` on a re-run usually just means a lock that has not settled yet.

```powershell
$dir = "myrepo_FEATURE-123"
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*$dir*" -and $_.Name -notmatch "^(pwsh|bash)\.exe$" } |
  Select-Object ProcessId, Name
```

Removing a worktree **by hand** hits the same failure and leaves the same orphan, so follow it with `--apply --purge-ignored`. A branch carrying un-pushed commits survives either way, since `git branch -d` refuses it, so the commits are still there and the worktree comes back with `git worktree add ../<dir> <branch>`.

## Safety rules (all enforced, none bypassable via flags)

1. **Protected primary directories** are never removed by name (the list of main checkouts lives at the top of the script).
2. **The main checkout is always skipped**: the first entry of `git worktree list` is never touched.
3. **Dirty worktrees are skipped with a warning**: any uncommitted change (`git status --porcelain` non-empty) blocks removal.
4. **Un-pushed commits are skipped with a warning**: any commit ahead of `@{u}` blocks removal.
5. **A merged PR is required**: removal happens only when `gh pr list --state merged --head <branch>` returns at least one entry.

Also skipped, each with the reason printed: a detached HEAD (no branch to check against a PR), a locked worktree, and one whose directory is gone (reported with the `git worktree prune` hint instead of being touched).

After `git worktree remove`, the script runs `git branch -d <branch>` (safe delete, which fails silently if the branch is not already merged git-side). It never force-deletes.

The `gh pr list` lookups run 6 at a time, since one network call per worktree is what the runtime is made of. Exit codes: `0` ok (dry-run included), `1` a removal failed, `2` usage or setup error.

## Requirements

Node 22+, `git`, and the `gh` CLI authenticated.
