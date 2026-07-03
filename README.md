# skills

Personal Claude Code skills, one folder per skill.

## Skills

| Skill | Type | Description |
| --- | --- | --- |
| [llm-council](llm-council/SKILL.md) | user | Pressure-test a decision through a council of 5 independent Claude advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) with anonymous peer review and a chairman synthesis. Claude-only adaptation of Karpathy's LLM Council. |
| [save-session](save-session/SKILL.md) | user | Summarize the current conversation and save it as a structured markdown file in `~/.claude/chats/`. Captures decisions, files touched, key commands, and session metadata. |
| [handoff](handoff/SKILL.md) | user | Compact the current conversation into a handoff document for another agent to pick up. |
| [pr-review](pr-review/SKILL.md) | user or project | Review a PR, branch, or uncommitted working-tree diff CodeRabbit-style. Runs the bundled diff-scoped static analyzer (`scripts/pr-review.mjs`) against the current git repo (or any repo via `--repo <path>`), then writes a structured review with findings grouped by severity. |

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
