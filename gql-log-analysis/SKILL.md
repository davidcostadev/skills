---
name: gql-log-analysis
description: Analyze API logs and report the heaviest and most frequent GraphQL operations - per-request latency (avg/p50/p95/p99/max), where total server time goes, the heaviest mutations and error rates per operation. Use when the user asks "quais as queries mais pesadas/frequentes", "analisar logs da API", or "quais mutations estao lentas".
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/gql-log-analysis.mjs` (Node 22+, no dependencies) turns raw API logs into a Markdown report: the heaviest GraphQL operations by per-request latency, the most frequent ones, the heaviest mutations, where the total server time goes (count x avg), and error rates per operation.

## It autodetects the log shape per line

- structured pino JSON from ECS/CloudWatch (`operationName` + `responseTime`)
- the GraphQL logger plugin's text lines from local dev (`[GraphQL] query x [id] user +123ms`, ANSI stripped)
- CloudWatch `--format short` prefixes, and the tab-separated CloudWatch exports
- a pino-pretty fallback

Production logs omit the operation type, so it classifies query vs mutation by scanning the operation definitions in the frontend sources (`query LeaderWorkerProfile {` -> query), falling back to the root fields of the API's `schema.gql`. Unmatched names show as `?`. Skip the scan with `--no-ops-scan`.

## Usage

```bash
# Fetch straight from CloudWatch (needs aws CLI credentials) and analyze.
./scripts/gql-log-analysis.mjs --env dev --since 2h
./scripts/gql-log-analysis.mjs --env staging --since 1d --only mutation

# Or pipe / pass files (local dev output, saved exports).
aws logs tail /ecs/myservice-dev-api --since 6h --format short --color off | ./scripts/gql-log-analysis.mjs
./scripts/gql-log-analysis.mjs api.log --top 20 --sort total

# Machine-readable.
./scripts/gql-log-analysis.mjs --env dev --since 1h --json
```

## Reference

Flags: `--env dev|staging|prod` (picks the log group), `--since` (aws tail syntax: 30m, 6h, 3d), `--top <n>` (default 15), `--only query|mutation`, `--min-count <n>` (default 2, which keeps single outliers out of the heaviest tables), `--sort p95|avg|max|total|count` (default p95), `--schema <path>`, `--json`. Output is Markdown on stdout. Run `--help` for the full reference.

## Requirements

Node 22+. The `--env` mode needs the `aws` CLI with credentials; piping or passing files needs nothing.
