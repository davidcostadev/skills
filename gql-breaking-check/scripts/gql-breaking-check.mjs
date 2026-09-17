#!/usr/bin/env node
// gql-breaking-check.mjs
//
// Detects GraphQL breaking changes and consumer drift across the long-lived
// environment branches (dev / staging / main) in one command.
//
// For each environment it:
//   1. Loads the API GraphQL schema for that env
//        - mode=local (default): git show origin/<env>:src/schema.gql  (no checkout, no server)
//        - mode=api:             live introspection of that env's /graphql endpoint
//   2. Validates that the app and admin operations on the SAME env branch still
//      match that schema (i.e. their `pnpm codegen` would not break).
//   3. Diffs the API schema between environments (promotion path dev -> staging -> main)
//      and reports breaking + dangerous changes.
//
// Everything reads straight from git, so all three environments are checked at
// once without touching any working directory. Reports land under
// e2s/gql-sync-reports/<timestamp>/ (report.md + report.json).
//
// Usage:
//   ./scripts/gql-breaking-check.mjs                       # local mode, dev+staging+main
//   ./scripts/gql-breaking-check.mjs --envs dev,staging    # subset of envs
//   ./scripts/gql-breaking-check.mjs --only admin          # one consumer
//   ./scripts/gql-breaking-check.mjs --mode api --url-dev http://localhost:4000/graphql
//   ./scripts/gql-breaking-check.mjs --strict              # exit 1 also on cross-env breaking changes
//   ./scripts/gql-breaking-check.mjs --help

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2S_ROOT = path.resolve(SCRIPT_DIR, '..');

// ---- repo / consumer config ------------------------------------------------

const API_REPO = 'eats2seats-api';
const API_SCHEMA_FILE = 'src/schema.gql';

// Each consumer mirrors its codegen.ts schema assembly so validation matches a
// real `pnpm codegen` run (the app merges two local supplementary schema files).
const CONSUMERS = {
  app: {
    repo: 'eats2seats-app',
    supplements: ['src/gql/address-search-schema.graphql', 'src/gql/mobile-api-schema-overrides.graphql'],
  },
  admin: {
    repo: 'eats2seats-admin',
    supplements: [],
  },
};

// Code promotes in this direction: dev -> staging -> main. Promotion hops are
// built from consecutive present environments in this order. A hop validates the
// SOURCE env's consumer operations against the TARGET env's API schema, i.e.
// "if we promote app/admin one step up, does the target env's API still serve
// their operations?". The reverse direction is intentionally never checked.
const PROMOTION_ORDER = ['dev', 'staging', 'main'];

// Apollo client-only directives are not part of the server schema; declare them
// so KnownDirectives does not flag operations that legitimately use them.
const CLIENT_DIRECTIVES_SDL = `
directive @client(always: Boolean) on FIELD | FRAGMENT_DEFINITION | INLINE_FRAGMENT
directive @connection(key: String!, filter: [String!]) on FIELD
directive @nonreactive on FIELD | FRAGMENT_SPREAD
directive @export(as: String!) on FIELD
`;

// Validation rules that fire on cross-file bundling rather than schema
// compatibility. Dropping them avoids noise while keeping every "field/type/arg
// no longer exists" rule that actually signals a breaking change.
const NOISE_RULES = new Set(['NoUnusedFragmentsRule', 'UniqueFragmentNamesRule', 'UniqueOperationNamesRule']);

// ---- graphql tooling (resolved from a consumer's node_modules) -------------

function loadTooling() {
  const owners = ['eats2seats-app', 'eats2seats-admin', 'eats2seats-api'];
  const owner = owners.find((r) =>
    fs.existsSync(path.join(E2S_ROOT, r, 'node_modules', '@graphql-tools', 'graphql-tag-pluck')),
  );
  if (!owner) {
    fail(
      'Could not find @graphql-tools/graphql-tag-pluck in any consumer node_modules.\n' +
        'Run `pnpm install` in eats2seats-app first (its deps power this script).',
    );
  }
  const req = createRequire(path.join(E2S_ROOT, owner, 'node_modules', '__resolve__.cjs'));
  return {
    graphql: req('graphql'),
    pluck: req('@graphql-tools/graphql-tag-pluck'),
    schemaTools: req('@graphql-tools/schema'),
  };
}

// ---- git helpers (read-only, branch-agnostic via git show) -----------------

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', path.join(E2S_ROOT, repo), ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
}

function gitShow(repo, ref, file) {
  try {
    return git(repo, ['show', `${ref}:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function resolveRef(repo, env, prefix) {
  for (const candidate of [`${prefix}${env}`, env]) {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function shortSha(repo, ref) {
  try {
    return git(repo, ['rev-parse', '--short', ref], { stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '???????';
  }
}

// Last commit metadata (ISO 8601 in the machine's local timezone + author).
// Pass `file` to get the last commit that touched that path, omit it for the
// branch HEAD.
function lastCommitMeta(repo, ref, file) {
  try {
    const out = git(
      repo,
      ['log', '-1', '--date=iso-strict-local', '--format=%h%x09%ad%x09%an%x09%s', ref, ...(file ? ['--', file] : [])],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!out) return null;
    const [sha, date, author, ...subject] = out.split('\t');
    return { sha, date, author, subject: subject.join('\t') };
  } catch {
    return null;
  }
}

function listGqlFiles(repo, ref, allDocuments) {
  let out;
  try {
    out = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', 'src'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const lines = out.split('\n').filter(Boolean);
  if (allDocuments) return lines.filter((f) => /\.tsx?$/.test(f) && !f.startsWith('src/gql/'));
  return lines.filter((f) => /\/gql\/.+\.tsx?$/.test(f));
}

// ---- schema building -------------------------------------------------------

let GQL; // graphql module
let SCHEMA_TOOLS;
let PLUCK;

function buildApiSchemaSdlLocal(env, refPrefix) {
  const ref = resolveRef(API_REPO, env, refPrefix);
  if (!ref) return { error: `no ref for ${API_REPO} (${refPrefix}${env} / ${env})` };
  const sdl = gitShow(API_REPO, ref, API_SCHEMA_FILE);
  if (sdl == null) return { error: `${API_SCHEMA_FILE} not found at ${ref}` };
  return {
    sdl,
    ref,
    sha: shortSha(API_REPO, ref),
    schemaCommit: lastCommitMeta(API_REPO, ref, API_SCHEMA_FILE),
  };
}

async function buildApiSchemaSdlApi(env, opts) {
  const url = opts.urls[env];
  if (!url) {
    return {
      error:
        `no endpoint URL for env "${env}". Pass --url-${env} <url> or set E2S_GQL_URL_${env.toUpperCase()}. ` +
        `(Note: introspection is usually disabled on staging/prod.)`,
    };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({ query: GQL.getIntrospectionQuery(), operationName: 'IntrospectionQuery' }),
    });
    const json = await res.json();
    if (json.errors) return { error: `introspection error: ${JSON.stringify(json.errors).slice(0, 200)}` };
    const schema = GQL.buildClientSchema(json.data);
    return { sdl: GQL.printSchema(schema), ref: url, sha: 'live', schemaCommit: null };
  } catch (e) {
    return { error: `introspection failed for ${url}: ${e.message}` };
  }
}

// Builds the executable schema a given consumer validates against, merging the
// consumer's supplementary SDL files plus client-only directive defs.
function buildConsumerSchema(apiSdl, consumer, ref) {
  const typeDefs = [apiSdl, CLIENT_DIRECTIVES_SDL];
  const supplementWarnings = [];
  for (const file of CONSUMERS[consumer].supplements) {
    const sdl = ref ? gitShow(CONSUMERS[consumer].repo, ref, file) : null;
    if (sdl != null) typeDefs.push(sdl);
    else supplementWarnings.push(`supplement ${file} not found at ${ref ?? '(unresolved ref)'}`);
  }
  try {
    const schema = SCHEMA_TOOLS.makeExecutableSchema({ typeDefs: typeDefs.filter(Boolean), assumeValidSDL: false });
    GQL.assertValidSchema(schema); // turn an unbuildable merge into a reported error, not a crash
    return { schema, supplementWarnings };
  } catch (e) {
    return { error: `failed to build ${consumer} schema: ${e.message}`, supplementWarnings };
  }
}

// ---- operation extraction + validation -------------------------------------

function pluckOperations(repo, ref, allDocuments) {
  const files = listGqlFiles(repo, ref, allDocuments);
  const segments = [];
  for (const file of files) {
    const code = gitShow(repo, ref, file);
    if (code == null) continue;
    let plucked;
    try {
      plucked = PLUCK.gqlPluckFromCodeStringSync(file, code, {
        globalGqlIdentifierName: ['gql', 'graphql'],
        gqlMagicComment: 'GraphQL',
      });
    } catch {
      continue; // unparseable file -> skip (not a schema concern)
    }
    // pluck returns an array of Source objects (one per operation) in current
    // versions, a single string in older ones. Normalize to operation strings.
    const sources = Array.isArray(plucked) ? plucked : plucked ? [plucked] : [];
    for (const s of sources) {
      const body = typeof s === 'string' ? s : s?.body;
      if (body && body.trim()) segments.push({ file, sdl: body });
    }
  }
  return segments;
}

// Validates all plucked operations of one consumer against `schema`, mapping
// each error back to its source file via line offsets in the bundled document.
function validateOperations(schema, segments) {
  if (segments.length === 0) return { ok: true, fileCount: 0, opCount: 0, errors: [] };

  let combined = '';
  let line = 1;
  const offsets = []; // { file, startLine }
  for (const { file, sdl } of segments) {
    offsets.push({ file, startLine: line });
    combined += sdl + '\n\n';
    line += (sdl.match(/\n/g)?.length ?? 0) + 2;
  }

  let doc;
  try {
    doc = GQL.parse(combined);
  } catch (e) {
    return {
      ok: false,
      fileCount: segments.length,
      opCount: 0,
      errors: [{ file: fileForLine(offsets, e.locations?.[0]?.line), message: `syntax: ${e.message}` }],
    };
  }

  const opCount = doc.definitions.filter((d) => d.kind === 'OperationDefinition').length;
  const fileCount = new Set(segments.map((s) => s.file)).size;
  const rules = GQL.specifiedRules.filter((r) => !NOISE_RULES.has(r.name));
  const errors = GQL.validate(schema, doc, rules);

  return {
    ok: errors.length === 0,
    fileCount,
    opCount,
    errors: errors.map((e) => ({
      file: fileForLine(offsets, e.locations?.[0]?.line),
      message: e.message,
    })),
  };
}

function fileForLine(offsets, lineNo) {
  if (!lineNo) return '(unknown file)';
  let match = offsets[0]?.file ?? '(unknown file)';
  for (const o of offsets) {
    if (o.startLine <= lineNo) match = o.file;
    else break;
  }
  return match;
}

// Validates one consumer's operations against `apiSdl`, merging the consumer's
// own supplementary schema files (read at `consumerRef`) to mirror its codegen.
// Used both intra-env (apiSdl from the same env) and per promotion hop (apiSdl
// from the TARGET env, consumerRef from the SOURCE env).
function checkConsumer(apiSdl, consumer, consumerRef, segments) {
  const built = buildConsumerSchema(apiSdl, consumer, consumerRef);
  if (built.error) return { ref: consumerRef, error: built.error, supplementWarnings: built.supplementWarnings };
  return {
    ref: consumerRef,
    supplementWarnings: built.supplementWarnings,
    ...validateOperations(built.schema, segments),
  };
}

// ---- reporting -------------------------------------------------------------

function schemaCommitMd(sc) {
  return sc ? [`    - schema last changed: ${sc.date} by ${sc.author} (\`${sc.sha}\` ${sc.subject})`] : [];
}

// One consumer result rendered as markdown bullets. `label` describes what was
// validated against what (intra-env vs a promotion hop).
function consumerMd(label, c) {
  if (c.skipped) return [`- [SKIP] ${label}: ${c.skipped}`];
  const warnings = (c.supplementWarnings ?? []).map((w) => `    - [WARN] ${w}`);
  if (c.error) return [`- [FAIL] ${label}: ${c.error}`, ...warnings];
  const status = c.ok ? '[PASS]' : '[FAIL]';
  return [
    `- ${status} ${label}: ${c.opCount} operations in ${c.fileCount} files, ${c.errors.length} invalid`,
    ...warnings,
    ...c.errors.map((err) => `    - [FAIL] ${err.file}: ${err.message}`),
  ];
}

function buildReport(result) {
  const lines = [];
  lines.push(`# GraphQL Sync Report`);
  lines.push('');
  lines.push(`- Mode: \`${result.mode}\``);
  lines.push(`- Environments: ${result.envs.join(', ')}`);
  lines.push(`- Generated: ${result.generatedAt}`);
  lines.push('');

  lines.push(`## Intra-environment (does each env's API break its own app/admin)`);
  lines.push('');
  for (const env of result.envs) {
    const e = result.environments[env];
    lines.push(`### ${env}`);
    if (e.api.error) {
      lines.push(`- [FAIL] API schema: ${e.api.error}`, '');
      continue;
    }
    lines.push(`- API schema: \`${API_REPO}\` @ \`${e.api.ref}\` (${e.api.sha})`, ...schemaCommitMd(e.api.schemaCommit));
    for (const consumer of Object.keys(CONSUMERS)) {
      if (e.intra[consumer]) lines.push(...consumerMd(`${consumer} (\`${e.intra[consumer].ref ?? '?'}\`)`, e.intra[consumer]));
    }
    lines.push('');
  }

  lines.push(`## Promotion hops (source-env consumer vs target-env API) - direction dev -> staging -> main`);
  lines.push('');
  if (result.hops.length === 0) lines.push('_No consecutive environments to form a promotion hop._');
  for (const hop of result.hops) {
    lines.push(`### ${hop.from} -> ${hop.to}`);
    lines.push(
      `- Target API: \`${API_REPO}\` @ \`${hop.targetApi.ref}\` (${hop.targetApi.sha})`,
      ...schemaCommitMd(hop.targetApi.schemaCommit),
    );
    for (const consumer of Object.keys(CONSUMERS)) {
      if (hop.consumers[consumer]) lines.push(...consumerMd(`${consumer} (${hop.from} ops) -> api:${hop.to}`, hop.consumers[consumer]));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// One consumer result rendered as colored console lines.
function consumerConsole(C, label, c) {
  if (c.skipped) return [`  ${C.dim('SKIP')} ${label}: ${c.skipped}`];
  const warnings = (c.supplementWarnings ?? []).map((w) => `       ${C.yellow('warn')} ${w}`);
  if (c.error) return [`  ${C.red('FAIL')} ${label}: ${c.error}`, ...warnings];
  const tag = c.ok ? C.green('PASS') : C.red('FAIL');
  const shown = c.errors.slice(0, 25).map((err) => `       ${C.red('x')} ${err.file}: ${err.message}`);
  const overflow = c.errors.length > 25 ? [C.dim(`       ... ${c.errors.length - 25} more (see report.md)`)] : [];
  return [`  ${tag} ${label}  ${c.opCount} ops / ${c.fileCount} files  ${c.errors.length} invalid`, ...warnings, ...shown, ...overflow];
}

function printConsole(result) {
  const C = process.stdout.isTTY
    ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
    : { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };
  const commit = (sc, label) => (sc ? console.log(C.dim(`     ${label} last changed: ${sc.date} by ${sc.author} (${sc.sha} ${sc.subject})`)) : undefined);

  console.log('');
  console.log(C.bold(`GraphQL Sync Report  (mode: ${result.mode})`));
  console.log(C.dim(`envs: ${result.envs.join(', ')}`));
  console.log('');

  console.log(C.bold('Intra-environment (api:<env> vs its own app/admin):'));
  console.log('');
  for (const env of result.envs) {
    const e = result.environments[env];
    if (e.api.error) {
      console.log(`${C.red('FAIL')} ${C.bold(env)}  API schema: ${e.api.error}\n`);
      continue;
    }
    console.log(`${C.bold(env)}  ${C.dim(`${API_REPO}@${e.api.ref} (${e.api.sha})`)}`);
    commit(e.api.schemaCommit, 'schema');
    for (const consumer of Object.keys(CONSUMERS)) {
      if (e.intra[consumer]) for (const ln of consumerConsole(C, consumer, e.intra[consumer])) console.log(ln);
    }
    console.log('');
  }

  console.log(C.bold('Promotion hops (source consumer -> target API), dev -> staging -> main:'));
  console.log('');
  if (result.hops.length === 0) console.log(C.dim('  (no consecutive envs to form a hop)'));
  for (const hop of result.hops) {
    console.log(`${C.bold(`${hop.from} -> ${hop.to}`)}  ${C.dim(`target ${API_REPO}@${hop.targetApi.ref} (${hop.targetApi.sha})`)}`);
    commit(hop.targetApi.schemaCommit, 'target schema');
    for (const consumer of Object.keys(CONSUMERS)) {
      if (hop.consumers[consumer]) for (const ln of consumerConsole(C, `${consumer} (${hop.from} ops) -> api:${hop.to}`, hop.consumers[consumer])) console.log(ln);
    }
    console.log('');
  }
}

// ---- main ------------------------------------------------------------------

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function printHelp() {
  console.log(`gql-breaking-check.mjs - GraphQL breaking-change + consumer-drift check across env branches

Usage: ./scripts/gql-breaking-check.mjs [options]

Options:
  --mode <local|api>      local (default): read schema.gql from git per branch.
                          api: introspect each env's live /graphql endpoint.
  --envs <list>           comma list of env branches. Default: dev,staging,main
  --only <app|admin>      check a single consumer (default: both)
  --ref-prefix <p>        ref prefix for branch resolution. Default: origin/
  --all-documents         pluck every src/**/*.ts(x), not just */gql/*.ts
  --strict                exit 1 also when a promotion hop is incompatible
                          (source-env consumer needs schema not yet in target)
  --fetch                 git fetch --all --prune each repo before reading
  --json                  print machine-readable JSON to stdout
  --no-report             do not write report files to disk
  --report-dir <dir>      where to write report.{md,json}
                          Default: <e2s>/gql-sync-reports/<timestamp>/
  --url-dev / --url-staging / --url-main <url>   endpoint URLs for --mode api
  --header "Key: Value"   extra header(s) for --mode api (repeatable)
  --help

Checks run in two parts:
  - Intra-environment: api:<env> vs app:<env>/admin:<env> (does the env's API
    break its own consumers).
  - Promotion hops (dev -> staging -> main only): the SOURCE env's consumer
    operations validated against the TARGET env's API schema.

Exit codes: 0 = all in sync; 1 = an intra-env consumer is out of sync
            (or a promotion hop is incompatible with --strict);
            2 = setup / API-load error.`);
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        mode: { type: 'string', default: 'local' },
        envs: { type: 'string', default: 'dev,staging,main' },
        only: { type: 'string' },
        'ref-prefix': { type: 'string', default: 'origin/' },
        'all-documents': { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        fetch: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'no-report': { type: 'boolean', default: false },
        'report-dir': { type: 'string' },
        'url-dev': { type: 'string' },
        'url-staging': { type: 'string' },
        'url-main': { type: 'string' },
        header: { type: 'string', multiple: true },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    fail(e.message);
  }

  if (args.help) {
    printHelp();
    return;
  }
  if (!['local', 'api'].includes(args.mode)) fail(`--mode must be local or api (got "${args.mode}")`);

  const envs = args.envs.split(',').map((s) => s.trim()).filter(Boolean);
  const consumers = args.only ? [args.only] : Object.keys(CONSUMERS);
  for (const c of consumers) if (!CONSUMERS[c]) fail(`--only must be one of: ${Object.keys(CONSUMERS).join(', ')}`);

  const tooling = loadTooling();
  GQL = tooling.graphql;
  SCHEMA_TOOLS = tooling.schemaTools;
  PLUCK = tooling.pluck;

  if (args.fetch) {
    const repos = new Set([API_REPO, ...consumers.map((c) => CONSUMERS[c].repo)]);
    for (const repo of repos) {
      try {
        git(repo, ['fetch', '--all', '--prune', '--quiet']);
      } catch (e) {
        console.error(`warn: git fetch failed for ${repo}: ${e.message}`);
      }
    }
  }

  const apiOpts = {
    urls: {
      dev: args['url-dev'] || process.env.E2S_GQL_URL_DEV,
      staging: args['url-staging'] || process.env.E2S_GQL_URL_STAGING,
      main: args['url-main'] || process.env.E2S_GQL_URL_MAIN,
    },
    headers: parseHeaders(args.header),
  };

  const apiSdlByEnv = {};
  const cache = {}; // env -> consumer -> { ref, segments }  (operations, not serialized)
  const result = {
    mode: args.mode,
    envs,
    generatedAt: new Date().toISOString(),
    environments: {},
    hops: [],
  };

  // Pass 1: load each env's API schema, pluck consumer operations, and run the
  // intra-env check (api:<env> vs app:<env>/admin:<env>).
  for (const env of envs) {
    const api =
      args.mode === 'api' ? await buildApiSchemaSdlApi(env, apiOpts) : buildApiSchemaSdlLocal(env, args['ref-prefix']);
    if (api.error) {
      result.environments[env] = { api: { error: api.error }, intra: {} };
      continue;
    }
    apiSdlByEnv[env] = api.sdl; // full SDL kept out of the serialized result
    cache[env] = {};
    result.environments[env] = { api: { ref: api.ref, sha: api.sha, schemaCommit: api.schemaCommit }, intra: {} };

    for (const consumer of consumers) {
      const repo = CONSUMERS[consumer].repo;
      const ref = resolveRef(repo, env, args['ref-prefix']);
      if (!ref) {
        result.environments[env].intra[consumer] = { skipped: `no ${repo} branch for ${env}` };
        continue;
      }
      const segments = pluckOperations(repo, ref, args['all-documents']);
      cache[env][consumer] = { ref, segments };
      result.environments[env].intra[consumer] = checkConsumer(apiSdlByEnv[env], consumer, ref, segments);
    }
  }

  // Pass 2: promotion hops in the dev -> staging -> main direction only. Each hop
  // validates the SOURCE env's consumer operations against the TARGET env's API
  // schema ("does promoting app/admin one step up still work against that env").
  const ordered = PROMOTION_ORDER.filter((e) => envs.includes(e) && apiSdlByEnv[e]);
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const hop = { from, to, targetApi: result.environments[to].api, consumers: {} };
    for (const consumer of consumers) {
      const src = cache[from]?.[consumer];
      if (!src) {
        hop.consumers[consumer] = { skipped: `no ${from} ${consumer} operations` };
        continue;
      }
      hop.consumers[consumer] = checkConsumer(apiSdlByEnv[to], consumer, src.ref, src.segments);
    }
    result.hops.push(hop);
  }

  // ---- failure counts for exit status ----
  const isFail = (c) => c && !c.skipped && (c.error || c.ok === false);
  let apiFailures = 0;
  let intraFailures = 0;
  let hopFailures = 0;
  for (const env of envs) {
    if (result.environments[env].api.error) apiFailures++;
    for (const consumer of consumers) if (isFail(result.environments[env].intra[consumer])) intraFailures++;
  }
  for (const hop of result.hops) for (const consumer of consumers) if (isFail(hop.consumers[consumer])) hopFailures++;

  // ---- output ----
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printConsole(result);
  }

  if (!args['no-report']) {
    const stamp = result.generatedAt.replace(/[:.]/g, '-');
    const reportDir = args['report-dir'] || path.join(E2S_ROOT, 'gql-sync-reports', stamp);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'report.md'), buildReport(result));
    fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(result, null, 2));
    if (!args.json) console.log(`report: ${path.relative(E2S_ROOT, reportDir)}/report.md`);
  }

  // Set exitCode (not process.exit) so buffered stdout/--json output flushes
  // fully before the process terminates.
  if (apiFailures > 0) process.exitCode = 2;
  else if (intraFailures > 0) process.exitCode = 1;
  else if (args.strict && hopFailures > 0) process.exitCode = 1;
  else process.exitCode = 0;
}

function parseHeaders(headerArgs) {
  const headers = {};
  if (process.env.E2S_GQL_TOKEN) headers['authorization'] = `Bearer ${process.env.E2S_GQL_TOKEN}`;
  for (const h of headerArgs ?? []) {
    const idx = h.indexOf(':');
    if (idx === -1) continue;
    headers[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
  }
  return headers;
}

main().catch((e) => fail(e.stack || e.message));
