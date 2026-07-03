# skills

Personal Claude Code skills, one folder per skill.

## Skills

| Skill | Type | Description |
| --- | --- | --- |
| [llm-council](llm-council/SKILL.md) | user | Pressure-test a decision through a council of 5 independent Claude advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) with anonymous peer review and a chairman synthesis. Claude-only adaptation of Karpathy's LLM Council. |
| [save-session](save-session/SKILL.md) | user | Summarize the current conversation and save it as a structured markdown file in `~/.claude/chats/`. Captures decisions, files touched, key commands, and session metadata. |
| [handoff](handoff/SKILL.md) | user | Compact the current conversation into a handoff document for another agent to pick up. |
| [pr-review](pr-review/SKILL.md) | project | Review a PR, branch, or uncommitted working-tree diff CodeRabbit-style. Runs the bundled diff-scoped static analyzer (`scripts/pr-review.mjs`), then writes a structured review with findings grouped by severity. |

## Installation

### User skills (llm-council, save-session, handoff)

User skills live in `~/.claude/skills/<name>/`. Either symlink (edits stay versioned in this clone) or copy:

```bash
git clone git@github.com:davidcostadev/skills.git ~/skills

# Symlink (recommended)
ln -s ~/skills/llm-council ~/.claude/skills/llm-council

# Or copy
cp -r ~/skills/llm-council ~/.claude/skills/
```

### Project skills (pr-review)

`pr-review` is a project skill: the SKILL.md goes into the project's `.claude/skills/` and its analyzer script into the project's `scripts/`:

```bash
cp -r ~/skills/pr-review <project>/.claude/skills/
cp ~/skills/pr-review/scripts/pr-review.mjs <project>/scripts/
```

Note: the analyzer script is currently tailored to a specific multi-repo workspace (hardcoded root path and repo-name mapping near the top of the file). Adjust those constants for your own project layout before using it elsewhere.

## Requirements

- `llm-council`, `save-session`, `handoff`: no external dependencies, SKILL.md only.
- `pr-review`: Node 22+ and pnpm. eslint, prettier and tsc come from the target repo's own devDependencies (invoked with `npx --no-install`); the duplication check fetches `jscpd@4` on demand via `pnpm dlx`.
