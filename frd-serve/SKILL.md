---
name: frd-serve
description: Render a directory of markdown docs as a small browsable site, either as an HTTP server or as static HTML for a static host. Dependency-free, with a markdown renderer that preserves deep nested lists instead of flattening them. Use when the user wants to preview, browse or publish markdown docs as a site.
metadata:
  author: davidcostadev
  version: "1.0"
---

`scripts/frd-serve.mjs` (Node 22+, no dependencies) renders markdown docs as a small site: a whole directory, or named files.

Two modes. `serve` runs an HTTP server, which is what a tunnel can point a hostname at; `build` writes static HTML for a static host.

**The bundled markdown renderer is deliberate, not laziness.** It covers exactly the subset these docs use, deep nested lists included, because in a structured requirements doc the nesting IS the content, and off-the-shelf renderers flatten it.

## Usage

```bash
node scripts/frd-serve.mjs                        # serve on http://localhost:8787
node scripts/frd-serve.mjs --port 3000
node scripts/frd-serve.mjs --dir docs/plans
node scripts/frd-serve.mjs --doc docs/reports/foo.md
node scripts/frd-serve.mjs build --out dist/site
node scripts/frd-serve.mjs --help
```

## noindex is not access control

Pages carry `noindex` and the server answers `/robots.txt` with a full `Disallow`. That keeps a tunnel that is public-by-default out of search results. It is **not** access control. Anything that must not be read by a stranger who guesses the URL needs an auth layer (Cloudflare Access or equivalent) in front of the hostname.

## Paths

The script resolves its document root relative to its own location's parent directory, so it expects to sit one level down from the repo root (`scripts/frd-serve.mjs`). Point it anywhere explicitly with `--dir` or `--doc`.

## Requirements

Node 22+. Nothing else.
