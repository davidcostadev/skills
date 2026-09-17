#!/usr/bin/env node
// gql-log-analysis.mjs
//
// Analyzes API logs and answers three questions:
//   1. Which GraphQL operations are the HEAVIEST (per-request latency)?
//   2. Which operations are the most FREQUENT?
//   3. Which MUTATIONS are the heaviest?
// Plus where the API time actually goes (count x avg = aggregate load) and
// which operations error the most.
//
// It understands every log shape the API produces, autodetected per line:
//   - Structured pino JSON (production/ECS): "request completed" records with
//     `operationName`, `responseTime` (ms), `graphqlOperationType`,
//     `graphqlHasErrors`. This is what lands in CloudWatch.
//   - GraphQLLoggerPlugin text (local dev with GRAPHQL_LOGGING=true):
//     `[GraphQL] query eventList [a1b2c3] user_xxx +123ms` (ANSI stripped).
//   - CloudWatch `aws logs tail --format short` prefixes (timestamp before the
//     JSON) and pino-pretty single-line output (generic fallback).
//
// Production logs omit `graphqlOperationType`, so operations are classified as
// query vs mutation by matching the operation name against the Query/Mutation
// fields of eats2seats-api/src/schema.gql (clients name operations after the
// field, e.g. `EventList` -> field `eventList`). Unmatched names show as `?`.
//
// Usage:
//   # Pipe from CloudWatch yourself...
//   aws logs tail /ecs/eats2seats-dev-api --since 2h --format short --color off \
//     | ./scripts/gql-log-analysis.mjs
//   # ...or let the script fetch (needs aws CLI credentials):
//   ./scripts/gql-log-analysis.mjs --env dev --since 2h
//   # Or analyze saved log files (local dev output, downloaded exports, ...):
//   ./scripts/gql-log-analysis.mjs api.log another.log
//
// Options:
//   --env <dev|staging|prod>  Fetch from CloudWatch group /ecs/eats2seats-<env>-api.
//   --since <dur|iso>         Lookback for --env (aws logs tail syntax, default 1h).
//   --top <n>                 Rows per table (default 15).
//   --only <query|mutation>   Restrict every table to one operation type.
//   --min-count <n>           Minimum samples for the "heaviest" tables (default 2,
//                             so a single slow outlier does not top the ranking).
//   --sort <p95|avg|max|total|count>  Ranking metric for heaviest tables (default p95).
//   --schema <path>           schema.gql used to classify untyped records
//                             (default: eats2seats-api/src/schema.gql).
//   --json                    Machine-readable output instead of Markdown.
//   --help

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2S_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SCHEMA = path.join(E2S_ROOT, 'eats2seats-api', 'src', 'schema.gql');
const ENVS = ['dev', 'staging', 'prod'];

function fail(msg, code = 2) {
  console.error(`gql-log-analysis: ${msg}`);
  process.exit(code);
}

function printHelp() {
  console.log(
    `gql-log-analysis - heaviest / most frequent GraphQL operations from API logs\n\n` +
      `Usage:\n` +
      `  ./scripts/gql-log-analysis.mjs [files...]        # or pipe logs on stdin\n` +
      `  ./scripts/gql-log-analysis.mjs --env dev --since 2h\n\n` +
      `Options:\n` +
      `  --env <dev|staging|prod>  Fetch /ecs/eats2seats-<env>-api via aws logs tail.\n` +
      `  --since <dur|iso>         Lookback for --env (default: 1h). Ex: 30m, 6h, 3d.\n` +
      `  --top <n>                 Rows per table (default: 15).\n` +
      `  --only <query|mutation>   Restrict all tables to one operation type.\n` +
      `  --min-count <n>           Min samples for the heaviest tables (default: 2).\n` +
      `  --sort <metric>           p95 (default) | avg | max | total | count.\n` +
      `  --schema <path>           schema.gql for query/mutation classification.\n` +
      `  --no-ops-scan             Skip scanning admin/app sources for operation types.\n` +
      `  --json                    JSON output.\n` +
      `  --help\n\n` +
      `Examples:\n` +
      `  aws logs tail /ecs/eats2seats-dev-api --since 6h --format short --color off \\\n` +
      `    | ./scripts/gql-log-analysis.mjs --top 20\n` +
      `  ./scripts/gql-log-analysis.mjs --env staging --since 1d --only mutation\n` +
      `  GRAPHQL_LOGGING dev output: ./scripts/gql-log-analysis.mjs api-dev.log`,
  );
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let opts;
let files;
try {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string' },
      help: { type: 'boolean' },
      json: { type: 'boolean' },
      'min-count': { type: 'string' },
      'no-ops-scan': { type: 'boolean' },
      only: { type: 'string' },
      schema: { type: 'string' },
      since: { type: 'string' },
      sort: { type: 'string' },
      top: { type: 'string' },
    },
  });
  opts = parsed.values;
  files = parsed.positionals;
} catch (err) {
  fail(err.message);
}

if (opts.help) {
  printHelp();
  process.exit(0);
}

const TOP = opts.top ? Number.parseInt(opts.top, 10) : 15;
const MIN_COUNT = opts['min-count'] ? Number.parseInt(opts['min-count'], 10) : 2;
const SORT = opts.sort ?? 'p95';
const ONLY = opts.only;

if (!Number.isInteger(TOP) || TOP < 1) fail('--top must be a positive integer');
if (!Number.isInteger(MIN_COUNT) || MIN_COUNT < 1) fail('--min-count must be a positive integer');
if (!['p95', 'avg', 'max', 'total', 'count'].includes(SORT)) {
  fail(`--sort must be one of p95, avg, max, total, count (got "${SORT}")`);
}
if (ONLY && !['query', 'mutation'].includes(ONLY)) fail('--only must be query or mutation');
if (opts.env && !ENVS.includes(opts.env)) fail(`--env must be one of ${ENVS.join(', ')}`);
if (opts.env && files.length > 0) fail('use either --env or file arguments, not both');
if (opts.since && !opts.env) fail('--since only makes sense with --env');

// ---------------------------------------------------------------------------
// Input acquisition
// ---------------------------------------------------------------------------

function readCloudWatch(env, since) {
  const group = `/ecs/eats2seats-${env}-api`;
  console.error(`Fetching ${group} (since ${since})...`);
  const res = spawnSync(
    'aws',
    ['logs', 'tail', group, '--since', since, '--format', 'short', '--color', 'off'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 },
  );
  if (res.error) fail(`could not run aws CLI: ${res.error.message}`);
  if (res.status !== 0) fail(`aws logs tail failed:\n${res.stderr?.trim()}`);
  return { label: `${group} (last ${since})`, text: res.stdout };
}

function readInput() {
  if (opts.env) return readCloudWatch(opts.env, opts.since ?? '1h');
  if (files.length > 0) {
    const chunks = files.map((f) => {
      if (!fs.existsSync(f)) fail(`file not found: ${f}`);
      return fs.readFileSync(f, 'utf8');
    });
    return { label: files.join(', '), text: chunks.join('\n') };
  }
  if (process.stdin.isTTY) fail('no input: pass log files, pipe logs on stdin, or use --env (see --help)');
  return { label: 'stdin', text: fs.readFileSync(0, 'utf8') };
}

// ---------------------------------------------------------------------------
// Schema-based classification (for prod records that lack the operation type)
// ---------------------------------------------------------------------------

// Returns { query: Set<lowercased field>, mutation: Set<...> } from schema.gql,
// or empty sets when the schema cannot be read (classification then degrades
// to "unknown" instead of failing the whole analysis).
function loadSchemaFields(schemaPath) {
  const result = { mutation: new Set(), query: new Set() };
  let text;
  try {
    text = fs.readFileSync(schemaPath, 'utf8');
  } catch {
    console.error(`gql-log-analysis: warning: cannot read schema at ${schemaPath}; untyped records stay "?"`);
    return result;
  }
  for (const rootType of ['Query', 'Mutation']) {
    const match = text.match(new RegExp(`type ${rootType} \\{([\\s\\S]*?)\\n\\}`));
    if (!match) continue;
    const target = result[rootType.toLowerCase()];
    for (const line of match[1].split('\n')) {
      const field = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/);
      if (field) target.add(field[1].toLowerCase());
    }
  }
  return result;
}

const schemaFields = loadSchemaFields(opts.schema ?? DEFAULT_SCHEMA);

// Consumer repos define every named operation (`query LeaderWorkerProfile {`),
// so scanning their sources gives an authoritative name -> type map - custom
// operation names never match a schema field, only this scan resolves them.
// Returns Map<operationName, 'query'|'mutation'|'subscription'>; a name defined
// with conflicting types (rare) is dropped so it falls back to "unknown".
function loadConsumerOperations(dirs) {
  const map = new Map();
  const conflicts = new Set();
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.expo']);
  const EXT_RE = /\.(ts|tsx|js|jsx|graphql|gql)$/;
  const OP_RE = /\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
      } else if (EXT_RE.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const match of text.matchAll(OP_RE)) {
          const [, type, name] = match;
          const existing = map.get(name);
          if (existing && existing !== type) conflicts.add(name);
          else map.set(name, type);
        }
      }
    }
  };

  for (const dir of dirs) visit(dir);
  for (const name of conflicts) map.delete(name);
  return map;
}

const DEFAULT_OPS_DIRS = [
  path.join(E2S_ROOT, 'eats2seats-admin', 'src'),
  path.join(E2S_ROOT, 'eats2seats-app', 'src'),
];
const consumerOps = opts['no-ops-scan'] ? new Map() : loadConsumerOperations(DEFAULT_OPS_DIRS);

// Classification order: the consumer-defined operation map (exact name), then
// the schema root fields for clients that name operations after the field
// (EventList -> eventList, with an optional "Query"/"Mutation" suffix).
function classifyByName(operationName) {
  const fromConsumers = consumerOps.get(operationName);
  if (fromConsumers) return fromConsumers;
  const lower = operationName.toLowerCase();
  const candidates = [lower, lower.replace(/(query|mutation)$/, '')];
  for (const candidate of candidates) {
    if (schemaFields.mutation.has(candidate)) return 'mutation';
    if (schemaFields.query.has(candidate)) return 'query';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B?\[[0-9;]*m/g;
const PLUGIN_RE =
  /\[GraphQL\]\s+(query|mutation|subscription)\s+(\S+)\s+\[[0-9a-f]+\]\s+\S+.*?\+(\d+)ms/;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;

// Parses one log line into { name, type, durationMs, error, time } or null when
// the line is not a completed GraphQL request (health checks, webhooks, noise).
function parseLine(rawLine) {
  const line = rawLine.replace(ANSI_RE, '').trim();
  if (!line) return null;

  // Structured pino JSON, possibly behind a CloudWatch "short" timestamp prefix.
  const braceIdx = line.indexOf('{');
  if (braceIdx !== -1 && line.endsWith('}')) {
    let record = null;
    try {
      record = JSON.parse(line.slice(braceIdx));
    } catch {
      // Not JSON after all - fall through to the text formats below.
    }
    if (record && typeof record === 'object') return parsePinoRecord(record);
  }

  // GraphQLLoggerPlugin text line.
  const plugin = line.match(PLUGIN_RE);
  if (plugin) {
    return {
      durationMs: Number(plugin[3]),
      error: /\bERROR\b/.test(line),
      name: plugin[2],
      time: parseTime(line.match(ISO_RE)?.[0]),
      type: plugin[1],
    };
  }

  // Generic fallback (pino-pretty single-line etc.): needs both an operation
  // name and a response time somewhere in the line.
  const nameMatch = line.match(/operationName["':=\s]+"?([A-Za-z_][A-Za-z0-9_]*)/);
  const timeMatch = line.match(/responseTime["':=\s]+"?(\d+(?:\.\d+)?)/);
  if (nameMatch && timeMatch) {
    return {
      durationMs: Number(timeMatch[1]),
      error: /"level":\s*(?:5\d)|\bERROR\b|graphqlHasErrors["':=\s]+true/.test(line),
      name: nameMatch[1],
      time: parseTime(line.match(ISO_RE)?.[0]),
      type: classifyByName(nameMatch[1]),
    };
  }

  return null;
}

function parsePinoRecord(record) {
  if (typeof record.responseTime !== 'number') return null;
  const url = record.req?.url ?? '';
  const name = record.operationName;
  // Records without an operation name are only GraphQL if the URL says so
  // (anonymous operations); everything else is /version, webhooks, etc.
  if (!name && !url.startsWith('/graphql')) return null;
  const operationName = name ?? 'anonymous';
  if (isIntrospection(operationName)) return null;
  return {
    durationMs: record.responseTime,
    error: record.graphqlHasErrors === true || (typeof record.level === 'number' && record.level >= 50),
    name: operationName,
    time: parseTime(record.time),
    type: record.graphqlOperationType ?? classifyByName(operationName),
  };
}

function isIntrospection(operationName) {
  return operationName === 'IntrospectionQuery';
}

function parseTime(value) {
  if (value === undefined || value === null) return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function analyze(text) {
  const ops = new Map();
  let totalLines = 0;
  let requests = 0;
  let firstTime = null;
  let lastTime = null;

  for (const rawLine of text.split('\n')) {
    totalLines += 1;
    const entry = parseLine(rawLine);
    if (!entry) continue;
    if (ONLY && entry.type !== ONLY) continue;
    requests += 1;
    if (entry.time) {
      if (!firstTime || entry.time < firstTime) firstTime = entry.time;
      if (!lastTime || entry.time > lastTime) lastTime = entry.time;
    }
    const key = `${entry.type}:${entry.name}`;
    let op = ops.get(key);
    if (!op) {
      op = { durations: [], errors: 0, name: entry.name, type: entry.type };
      ops.set(key, op);
    }
    op.durations.push(entry.durationMs);
    if (entry.error) op.errors += 1;
  }

  const stats = [...ops.values()].map((op) => {
    const sorted = [...op.durations].sort((a, b) => a - b);
    const total = sorted.reduce((sum, d) => sum + d, 0);
    return {
      avg: total / sorted.length,
      count: sorted.length,
      errors: op.errors,
      max: sorted[sorted.length - 1],
      name: op.name,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      total,
      type: op.type,
    };
  });

  return { firstTime, lastTime, requests, stats, totalLines };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const TYPE_LABEL = { mutation: 'mutation', query: 'query', subscription: 'subscription', unknown: '?' };

function fmtMs(ms) {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtTotal(ms) {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function heavyRows(stats, sortKey, top, minCount) {
  return stats
    .filter((s) => s.count >= minCount)
    .sort((a, b) => b[sortKey] - a[sortKey])
    .slice(0, top)
    .map((s, i) => [
      i + 1,
      `\`${s.name}\``,
      s.count,
      fmtMs(s.avg),
      fmtMs(s.p50),
      fmtMs(s.p95),
      fmtMs(s.p99),
      fmtMs(s.max),
      fmtTotal(s.total),
    ]);
}

const HEAVY_HEADERS = ['#', 'Operation', 'Count', 'Avg', 'p50', 'p95', 'p99', 'Max', 'Total'];

function report(label, analysis) {
  const { firstTime, lastTime, requests, stats } = analysis;
  const grandTotal = stats.reduce((sum, s) => sum + s.total, 0);
  const errors = stats.reduce((sum, s) => sum + s.errors, 0);
  const byType = { mutation: 0, query: 0, subscription: 0, unknown: 0 };
  for (const s of stats) byType[s.type] = (byType[s.type] ?? 0) + s.count;

  const lines = [];
  lines.push(`# GraphQL log analysis`);
  lines.push('');
  lines.push(`- Source: ${label}`);
  if (firstTime && lastTime) {
    lines.push(`- Window: ${firstTime.toISOString()} -> ${lastTime.toISOString()}`);
  }
  lines.push(
    `- Requests: ${requests} (${byType.query} queries, ${byType.mutation} mutations` +
      `${byType.unknown ? `, ${byType.unknown} unclassified` : ''}) | Errors: ${errors}`,
  );
  lines.push(`- Total server time in GraphQL: ${fmtTotal(grandTotal)} | Distinct operations: ${stats.length}`);
  lines.push('');

  if (requests === 0) {
    lines.push('No GraphQL requests found. Check the input format (see --help) or widen --since.');
    return lines.join('\n');
  }

  const sortLabel = SORT === 'count' ? 'count' : SORT;

  lines.push(`## Most frequent operations (top ${TOP})`);
  lines.push('');
  lines.push(
    table(
      ['#', 'Operation', 'Type', 'Count', '% of reqs', 'Errors', 'Avg', 'p95'],
      [...stats]
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP)
        .map((s, i) => [
          i + 1,
          `\`${s.name}\``,
          TYPE_LABEL[s.type],
          s.count,
          `${((s.count / requests) * 100).toFixed(1)}%`,
          s.errors || '',
          fmtMs(s.avg),
          fmtMs(s.p95),
        ]),
    ),
  );
  lines.push('');

  if (ONLY !== 'mutation') {
    lines.push(`## Heaviest queries (by ${sortLabel}, min ${MIN_COUNT} samples)`);
    lines.push('');
    const rows = heavyRows(stats.filter((s) => s.type === 'query'), SORT, TOP, MIN_COUNT);
    lines.push(rows.length ? table(HEAVY_HEADERS, rows) : '_No queries matched._');
    lines.push('');
  }

  if (ONLY !== 'query') {
    lines.push(`## Heaviest mutations (by ${sortLabel}, min ${MIN_COUNT} samples)`);
    lines.push('');
    const rows = heavyRows(stats.filter((s) => s.type === 'mutation'), SORT, TOP, MIN_COUNT);
    lines.push(rows.length ? table(HEAVY_HEADERS, rows) : '_No mutations matched._');
    lines.push('');
  }

  const unknownRows = heavyRows(stats.filter((s) => s.type === 'unknown'), SORT, TOP, MIN_COUNT);
  if (unknownRows.length > 0 && !ONLY) {
    lines.push(`## Unclassified operations (name not found in schema)`);
    lines.push('');
    lines.push(table(HEAVY_HEADERS, unknownRows));
    lines.push('');
  }

  lines.push(`## Where the time goes (aggregate load = sum of all request time)`);
  lines.push('');
  lines.push(
    table(
      ['#', 'Operation', 'Type', 'Count', 'Avg', 'Total', '% of total time'],
      [...stats]
        .sort((a, b) => b.total - a.total)
        .slice(0, TOP)
        .map((s, i) => [
          i + 1,
          `\`${s.name}\``,
          TYPE_LABEL[s.type],
          s.count,
          fmtMs(s.avg),
          fmtTotal(s.total),
          `${((s.total / grandTotal) * 100).toFixed(1)}%`,
        ]),
    ),
  );
  lines.push('');

  const withErrors = stats.filter((s) => s.errors > 0).sort((a, b) => b.errors - a.errors);
  if (withErrors.length > 0) {
    lines.push(`## Operations with errors`);
    lines.push('');
    lines.push(
      table(
        ['#', 'Operation', 'Type', 'Errors', 'Count', 'Error rate'],
        withErrors
          .slice(0, TOP)
          .map((s, i) => [
            i + 1,
            `\`${s.name}\``,
            TYPE_LABEL[s.type],
            s.errors,
            s.count,
            `${((s.errors / s.count) * 100).toFixed(1)}%`,
          ]),
      ),
    );
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const input = readInput();
const analysis = analyze(input.text);

if (opts.json) {
  console.log(
    JSON.stringify(
      {
        errors: analysis.stats.reduce((sum, s) => sum + s.errors, 0),
        operations: [...analysis.stats].sort((a, b) => b.total - a.total),
        requests: analysis.requests,
        source: input.label,
        window: {
          first: analysis.firstTime?.toISOString() ?? null,
          last: analysis.lastTime?.toISOString() ?? null,
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log(report(input.label, analysis));
}
