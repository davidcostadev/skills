#!/usr/bin/env node
// notify.mjs
//
// Sends a Telegram message through the eats2seats-bot, and - the main use -
// wraps any long-running command so you are pinged when it finishes. This is
// the callback layer for the gates (ci-gate, pipeline-gate, api/admin
// version-gate): an agent starts the gate in the background and you get the
// result on your phone instead of having to watch the terminal.
//
// No dependencies. Node 22+. Credentials come from the bot's own .env
// (eats2seats-bot/.env), so there is nothing extra to configure.
//
//   node scripts/notify.mjs "deploy terminou"
//   node scripts/notify.mjs --title "CI api#1039" -- node scripts/ci-gate.mjs wait --repo api --pr 1039
//   ./scripts/pending-promotion.mjs | node scripts/notify.mjs --title "Backlog" --stdin
//
// Run `--help` for the full reference.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_ENV = path.join(HERE, '..', 'eats2seats-bot', '.env');

// Telegram hard-caps a message at 4096 chars; leave room for the header we add.
const TELEGRAM_MAX = 4000;
const DEFAULT_TAIL_LINES = 15;

// Exit codes the e2s gates agree on. Anything else falls back to a plain
// "failed", which is the right reading for an arbitrary wrapped command too.
const EXIT_MEANING = {
  0: { emoji: '✅', label: 'terminou ok' },
  1: { emoji: '❌', label: 'falhou' },
  2: { emoji: '⚠️', label: 'erro de uso/setup' },
  124: { emoji: '⏱️', label: 'timeout' },
};

const GH_OWNER = process.env.E2S_GH_OWNER ?? 'Eats2Seats';
const JIRA_FALLBACK_URL = 'https://eatstoseats.atlassian.net';
const TICKET_RE = /\b(ETS-\d+)\b/i;

// Short repo aliases, mirroring the gates.
const REPO_ALIASES = {
  admin: 'eats2seats-admin',
  api: 'eats2seats-api',
  app: 'eats2seats-app',
  backoffice: 'eats2seats-backoffice',
  infra: 'eats2seats-infra',
};

// --- argument parsing (same shape as the gates) -----------------------------

/**
 * Splits argv at the first bare `--`: everything after it is the command to
 * wrap, verbatim, so the wrapped command can carry its own `--flags` without
 * colliding with ours.
 */
function parseArgs(argv) {
  const out = { _: [] };
  const cmd = [];
  let sawSeparator = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (sawSeparator) {
      cmd.push(a);
      continue;
    }
    if (a === '--') {
      sawSeparator = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next === '--' || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }

  out.cmd = cmd;
  return out;
}

function usage() {
  console.log(`notify.mjs - ping yourself on Telegram (via eats2seats-bot)

USAGE
  node scripts/notify.mjs [options] <message...>
  node scripts/notify.mjs [options] -- <command...>
  <something> | node scripts/notify.mjs [options] --stdin

MODES
  message      Sends the message as-is.
  wrap (--)    Runs the command with its output still on your terminal, then
               sends the outcome (emoji + exit code + duration). Exits with the
               command's own exit code, so it stays chainable.
  --stdin      Uses piped stdin as the message body.

LINKS (always included when they can be known)
  --pr <ref>         admin#968, 968 (with --repo admin), or a full GitHub URL.
  --ticket <KEY>     ETS-2468. Also picked up from --branch or from the title.
  --repo <name>      api/admin/app/infra, eats2seats-*, or owner/name.
  --no-links         Suppress the link line.
  In wrap mode these are SNIFFED from the wrapped command when not given, so
  wrapping a gate that already has --repo/--pr/--ticket needs no extra flags.

OPTIONS
  --title <t>        Bold first line. In wrap mode it defaults to the command.
  --only-fail        Wrap mode: notify only when the command does not exit 0.
  --tail <n>         Wrap mode: lines of output to include on failure (default ${DEFAULT_TAIL_LINES}, 0 = none).
  --no-tail          Same as --tail 0.
  --silent           Send without a notification sound.
  --chat-id <id>     Send somewhere other than your own chat.
  --raw-html         Do not HTML-escape the message (you are passing markup).
  --dry-run          Print what would be sent; send nothing.
  -h, --help         This text.

CONFIG
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the environment, falling back to
  ${path.relative(process.cwd(), BOT_ENV)}

EXAMPLES
  # The main one: an agent runs this in the background and you get pinged.
  node scripts/notify.mjs --title "CI api#1039" -- \\
    node scripts/ci-gate.mjs wait --repo api --pr 1039

  # Full chain around a PR, each step pinging you.
  node scripts/notify.mjs --title "CI app#585"       -- node scripts/ci-gate.mjs wait --repo app --pr 585
  node scripts/notify.mjs --title "Pipeline app#585" -- node scripts/pipeline-gate.mjs wait --repo app --pr 585
  node scripts/notify.mjs --title "Admin no ar"      -- node scripts/admin-version-gate.mjs wait --pr 711

  # Plain message, or a report piped in.
  node scripts/notify.mjs "ETS-2418 mergeado, promovendo pra staging"
  ./scripts/pending-promotion.mjs | node scripts/notify.mjs --title "Backlog de promocao" --stdin

EXIT CODES
  wrap mode: the wrapped command's own code. Otherwise 0 sent, 1 send failed,
  2 usage error. A failed send never masks the wrapped command's result.`);
}

// --- config -----------------------------------------------------------------

/**
 * Minimal KEY=VALUE reader for the bot's .env. Deliberately not dotenv: this
 * script has no node_modules of its own, and it only needs two flat values.
 * Missing file is not an error - the environment may already carry them.
 */
function readEnvFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function loadTelegramConfig(args) {
  const fromFile = readEnvFile(BOT_ENV);
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || fromFile.TELEGRAM_BOT_TOKEN;
  const chatId =
    (typeof args['chat-id'] === 'string' ? args['chat-id'] : null) ??
    (process.env.TELEGRAM_CHAT_ID?.trim() || fromFile.TELEGRAM_CHAT_ID);

  if (!botToken || !chatId) {
    fail(
      `Missing Telegram credentials. Set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, or make sure ${BOT_ENV} has them.`,
    );
  }
  return { botToken, chatId };
}

function fail(message, code = 2) {
  console.error(`notify: ${message}`);
  process.exit(code);
}

// --- message building -------------------------------------------------------

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "4m12s" / "38s" - a duration you read at a glance, not a precise one. */
function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m${String(sec).padStart(2, '0')}s`;
  const hours = Math.floor(min / 60);
  return `${hours}h${String(min % 60).padStart(2, '0')}m`;
}

// --- links ------------------------------------------------------------------
//
// A notification without a link is a dead end: you read it on the phone and
// then have to go hunt for the PR. So every message carries the PR and the
// ticket whenever they can be known - and in wrap mode they usually can be,
// because the gate being wrapped was already told which PR/ticket it watches.

function resolveRepo(value) {
  if (!value || value === true) return null;
  const v = String(value);
  if (v.includes('/')) return v; // already owner/name
  return `${GH_OWNER}/${REPO_ALIASES[v] ?? v}`;
}

/**
 * Reads PR/ticket from our own flags first, then falls back to sniffing the
 * WRAPPED command - `--repo admin --pr 968` is already there, so the common case
 * needs no extra typing and cannot drift out of sync with what is being watched.
 * `--branch` counts as a ticket source because branch name == ticket id here.
 */
/**
 * Which repo a wrapped gate is talking about when it was not told on the CLI.
 * The version gates each own one repo; ci-gate/pipeline-gate default to api.
 * This mirrors the gates' own defaults rather than guessing, so the link can
 * only point where the gate itself was already pointing.
 */
function inferRepoFromCmd(cmd) {
  const joined = cmd.join(' ');
  if (joined.includes('admin-version-gate')) return 'admin';
  if (joined.includes('api-version-gate')) return 'api';
  if (/ci-gate|pipeline-gate/.test(joined)) return process.env.E2S_CI_REPO ?? 'api';
  return null;
}

function resolveLinks(args, cmd) {
  const flag = (name) => {
    const own = args[name];
    if (typeof own === 'string') return own;
    const i = cmd.indexOf(`--${name}`);
    const next = i >= 0 ? cmd[i + 1] : undefined;
    return next && !next.startsWith('--') ? next : null;
  };

  let prUrl = null;
  let prLabel = null;
  const rawPr = flag('pr');
  if (rawPr) {
    const asUrl = /^https?:\/\//.test(rawPr) ? rawPr : null;
    // "admin#968" / "eats2seats-admin#968" / bare number needing --repo.
    const hashed = /^([\w-]+)#(\d+)$/.exec(rawPr);
    const repo = resolveRepo(hashed ? hashed[1] : (flag('repo') ?? inferRepoFromCmd(cmd)));
    const number = hashed ? hashed[2] : /^\d+$/.test(rawPr) ? rawPr : null;
    if (asUrl) {
      prUrl = asUrl;
      const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(asUrl);
      prLabel = m ? `${m[1].replace(/^eats2seats-/, '')}#${m[2]}` : 'PR';
    } else if (repo && number) {
      prUrl = `https://github.com/${repo}/pull/${number}`;
      prLabel = `${repo.split('/')[1].replace(/^eats2seats-/, '')}#${number}`;
    }
  }

  const ticketSource = flag('ticket') ?? flag('branch') ?? (typeof args.title === 'string' ? args.title : '') ?? '';
  const ticketMatch = TICKET_RE.exec(ticketSource);
  const ticket = ticketMatch ? ticketMatch[1].toUpperCase() : null;
  const jiraBase = (process.env.JIRA_BASE_URL ?? readEnvFile(BOT_ENV).JIRA_BASE_URL ?? JIRA_FALLBACK_URL).replace(
    /\/+$/,
    '',
  );

  const parts = [];
  if (prUrl) parts.push(`<a href="${prUrl}">${escapeHtml(prLabel ?? 'PR')}</a>`);
  if (ticket) parts.push(`<a href="${jiraBase}/browse/${ticket}">${ticket}</a>`);
  return parts.length > 0 ? `🔗 ${parts.join(' · ')}` : null;
}

/**
 * Trims to Telegram's limit from the END, keeping the head: the header and the
 * first lines carry the verdict, the tail is context.
 */
function clamp(text, max = TELEGRAM_MAX) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}\n[...truncado]`;
}

// --- sending ----------------------------------------------------------------

async function sendTelegram(config, text, { silent = false, dryRun = false } = {}) {
  if (dryRun) {
    console.log('--- notify --dry-run ---');
    console.log(text);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: silent,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${response.status} ${detail}`.trim());
  }
}

// --- wrap mode --------------------------------------------------------------

/**
 * Runs the command with its stdout/stderr still going to this terminal while
 * buffering the last `tailLines` lines, so a failure notification can carry the
 * reason with it. Buffering the tail (not the whole output) keeps memory flat
 * on a gate that polls for an hour.
 */
function runCommand(cmd, tailLines) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
    const tail = [];
    let pending = '';

    const absorb = (chunk, out) => {
      out.write(chunk);
      if (tailLines <= 0) return;
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        tail.push(line);
        if (tail.length > tailLines) tail.shift();
      }
    };

    child.stdout.on('data', (c) => absorb(c, process.stdout));
    child.stderr.on('data', (c) => absorb(c, process.stderr));

    const done = (code) => {
      if (pending && tailLines > 0) {
        tail.push(pending);
        if (tail.length > tailLines) tail.shift();
      }
      resolve({ code, durationMs: Date.now() - started, tail });
    };

    child.on('error', (err) => {
      console.error(`notify: could not run "${cmd[0]}": ${err.message}`);
      done(127);
    });
    // A killed child reports a signal and a null code; 128+signal is the shell
    // convention and keeps the exit code meaningful for the caller.
    child.on('close', (code, signal) => done(code ?? (signal ? 128 + (process.constants?.signals?.[signal] ?? 15) : 1)));
  });
}

function buildWrapMessage({ title, code, durationMs, tail, links }) {
  const meaning = EXIT_MEANING[code] ?? { emoji: '❌', label: 'falhou' };
  const header =
    `${meaning.emoji} <b>${escapeHtml(title)}</b> - ${meaning.label} ` +
    `<i>(exit ${code}, ${formatDuration(durationMs)})</i>`;

  // Links sit above the output tail: the tail can be long and gets clamped, the
  // links are what you actually tap.
  const lines = [header];
  if (links) lines.push(links);

  const body = tail.filter((l) => l.trim().length > 0);
  if (code !== 0 && body.length > 0) lines.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
  return lines.join('\n');
}

// --- main -------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const config = loadTelegramConfig(args);
  const dryRun = Boolean(args['dry-run']);
  const silent = Boolean(args.silent);
  const title = typeof args.title === 'string' ? args.title : null;

  // --- wrap mode
  if (args.cmd.length > 0) {
    const tailLines = args['no-tail']
      ? 0
      : args.tail !== undefined
        ? Number.parseInt(String(args.tail), 10) || 0
        : DEFAULT_TAIL_LINES;

    const result = await runCommand(args.cmd, tailLines);
    const shouldNotify = !args['only-fail'] || result.code !== 0;

    if (shouldNotify) {
      const text = clamp(
        buildWrapMessage({
          title: title ?? args.cmd.join(' '),
          code: result.code,
          durationMs: result.durationMs,
          tail: result.tail,
          links: args['no-links'] ? null : resolveLinks(args, args.cmd),
        }),
      );
      try {
        await sendTelegram(config, text, { silent, dryRun });
      } catch (err) {
        // Never let a Telegram hiccup rewrite the real result of the work.
        console.error(`notify: ${err.message}`);
      }
    }
    process.exit(result.code);
  }

  // --- message mode
  const body = args.stdin ? await readStdin() : args._.join(' ').trim();
  if (!body) {
    usage();
    fail('nothing to send (give a message, pipe with --stdin, or wrap a command after --)');
  }

  const safeBody = args['raw-html'] ? body : escapeHtml(body);
  const links = args['no-links'] ? null : resolveLinks(args, []);
  const text = clamp(
    [title ? `<b>${escapeHtml(title)}</b>` : null, safeBody, links].filter(Boolean).join('\n'),
  );

  try {
    await sendTelegram(config, text, { silent, dryRun });
  } catch (err) {
    fail(err.message, 1);
  }
}

main().catch((err) => fail(err?.stack ?? String(err), 1));
