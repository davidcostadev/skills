---
name: save-session
description: Summarize the current conversation and save it as a structured markdown file in ~/.claude/chats/. Captures decisions, files touched, key bash commands, verbatim quotes, completed tasks, and session metadata. Fast path - derives the title automatically and writes directly, no confirmation. Use at the end of a working session to preserve context for future reference.
metadata:
  author: david-costa
  version: "2.0"
---

# /save-session — Persist conversation context (fast)

Save the current conversation as a structured markdown doc in `~/.claude/chats/YYYY-MM-DD-<slug>.md`.

This is the **fast** version: no interactive questions, no preview/confirmation. Derive everything from the conversation and write directly. The only confirmation the user gets is the path printed at the end.

## When to invoke

- The user types `/save-session` (optionally followed by a title, e.g. `/save-session zeal-payout-bug`).
- End of a working session worth preserving.
- Before context compaction, to keep takeaways durable.

## Steps

### 1. Title and slug — NO question, derive directly

- **If the user passed an argument** after `/save-session`, use it as the title. Slugify it (lowercase, kebab-case, strip accents/punctuation).
- **Otherwise**, derive the title yourself from the dominant topic of the conversation (kebab-case slug, <=6 words). Do NOT ask the user — just pick a sensible one.

### 2. Session ID

Best-effort, in this order (don't block if both fail — leave `session_id: unknown`):
```bash
echo "$CLAUDE_SESSION_ID"                                    # (a) most reliable, if set
PROJECT_KEY=$(pwd | tr '/' '-')                              # (b) fallback: latest jsonl for cwd
ls -t "$HOME/.claude/projects/${PROJECT_KEY}/"*.jsonl 2>/dev/null | head -1 | xargs -I {} basename {} .jsonl
```

### 3. Destination path

Always under the home chats folder, regardless of the current working dir:
```
~/.claude/chats/YYYY-MM-DD-<slug>.md
```
Use today's date (`YYYY-MM-DD`). If that exact file already exists, append `-2`, `-3`, etc.

Ensure the directory exists:
```bash
mkdir -p "$HOME/.claude/chats"
```

### 4. Build and write the document — directly, no preview

Write this structure straight to disk (skip empty sections rather than padding):

```markdown
---
session_id: <uuid or "unknown">
date: <YYYY-MM-DD>
working_dir: <cwd>
title: <Human-readable title>
slug: <kebab-case slug>
duration_estimate: <"short" | "medium" | "long" — based on message count>
related_tickets: [<TICKET-123>, ...]   # if any mentioned, else omit
---

# <Human-readable title>

**Session:** `<session_id>`
**Date:** <YYYY-MM-DD>

---

## Resumo executivo

<2-4 sentences: what was the question, what was answered, what was decided.>

---

## Decisoes e acordos

<Concrete decisions reached. Each bullet self-contained, with the *what* and the *why* if there was rationale. Only "we decided X", not "we discussed X".>

---

## Tarefas concluidas

<Concrete deliverables - files written, code edited, docs created, syncs run. Not exploration.>

---

## Ficheiros tocados

<Every Read/Edit/Write target this session, deduped. Format: `- path/to/file.ext` - what was done.>

---

## Comandos-chave executados

<Bash commands with side effects or whose output drove decisions. Exact command. Skip trivial ls/cat/grep.>

---

## Frases verbatim (se aplicavel)

<Exact quotes if the session cited transcripts/meeting notes, with source attribution. Skip if none.>

---

## Pontos em aberto / proximos passos

<TBDs, unanswered questions, follow-ups for the user. Empty is fine - be honest.>

---

## Links e referencias

<Ticket URLs, paths to meeting summaries, related docs.>
```

### 5. After writing

Print one confirmation line with the absolute path:
```
Sessao guardada em ~/.claude/chats/YYYY-MM-DD-<slug>.md
```

Best-effort: if a Stop/SessionEnd hook logged this session as pending and that log file exists, drop the entry (no-op if the file is absent):
```bash
LOG="$CLAUDE_PROJECT_DIR/.claude/save-session-pending.log"
[ -f "$LOG" ] && grep -v "<session_id>" "$LOG" > /tmp/sslog && mv /tmp/sslog "$LOG"
```

## Important rules

- **Write directly — do not ask the user to confirm.** Speed is the point. The printed path is the only feedback.
- **Never invent decisions.** If nothing was decided on a topic, keep that section terse or omit it.
- **Preserve verbatim quotes exactly.** Re-read the source if unsure; do not paraphrase.
- **Match the user's language** for the body (Portuguese if the conversation was in Portuguese, English if English). Section headings stay as above.
- **Skip empty sections rather than padding.**
- **One file per session.** Don't merge sessions.
- **Do not commit the file.** Just write it.
