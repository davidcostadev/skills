---
name: gql-breaking-check
description: Detect GraphQL breaking changes and consumer drift across long-lived environment branches in one command, reading every branch straight from git with no checkout and no running API. Use when the user asks to "verificar breaking change de graphql", "checar se app/admin estao sincados com o schema da api", or before promoting a schema change between environments.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/gql-breaking-check.mjs` (Node 22+) validates frontend GraphQL operations against the API schema across every environment branch at once. Everything reads through `git show <branch>:<file>`, so all environments are checked without any checkout, worktree or running API.

It runs two checks:

- **Intra-environment**: for each env, the app and admin operations on that env branch are validated against the API schema on the same env branch. This answers "would their `pnpm codegen` break right now".
- **Promotion hops** (direction `dev -> staging -> main` only, never the reverse): for each consecutive pair, the SOURCE env's consumer operations are validated against the TARGET env's API schema. This catches a frontend that depends on a schema change not yet promoted to the target env, for example admin on dev using a field that only exists in the dev API, so promoting admin to staging would break against the staging API.

Each env and target line also shows when the API `schema.gql` last changed (ISO 8601 in local time) and who committed it.

## Usage

```bash
# Local mode (default): read schema.gql per branch, check dev + staging + main at once.
./scripts/gql-breaking-check.mjs

# Subset of envs / a single consumer.
./scripts/gql-breaking-check.mjs --envs dev,staging
./scripts/gql-breaking-check.mjs --only admin

# Live-introspection mode (needs reachable endpoints; introspection is usually off
# on staging and prod).
./scripts/gql-breaking-check.mjs --mode api --url-dev http://localhost:4000/graphql

# CI-friendly: exit 1 also when a promotion hop is incompatible; machine-readable.
./scripts/gql-breaking-check.mjs --strict
./scripts/gql-breaking-check.mjs --json
```

## Reference

Reports land under `gql-sync-reports/<timestamp>/` (`report.md` + `report.json`) outside every git repo, so no checkout is dirtied. Exit codes: `0` all in sync, `1` an intra-env consumer is out of sync (or a promotion hop is incompatible with `--strict`), `2` setup or API-load error.

Other flags: `--ref-prefix`, `--all-documents`, `--fetch`, `--no-report`, `--header`, plus the `E2S_GQL_URL_*` / `E2S_GQL_TOKEN` env vars. Run `--help` for the full list.

## Requirements

Node 22+ and `git`. It reuses the GraphQL libraries already installed in the app's `node_modules` rather than adding dependencies, so the consumer repo must have had its install run. The app's committed supplementary schema files are merged in to mirror its real codegen.
