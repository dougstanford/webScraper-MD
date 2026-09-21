# kb-clip

Clip a web page — or crawl a whole knowledge base — into Obsidian-optimized
Markdown that matches what the [Obsidian Web Clipper](https://obsidian.md/clipper)
browser extension produces.

It uses the same extraction stack as the extension: Mozilla **Readability** to
find the article, **Turndown** + the **GFM plugin** to convert it, and the
clipper's default frontmatter template on top.

```bash
node clip.mjs https://developer.affinity.co/pages/external-api-v2/introduction
```

```
---
title: "Introduction - Affinity Developer Documentation"
source: "https://developer.affinity.co/pages/external-api-v2/introduction"
author:
published:
created: 2026-09-21
description: "Welcome to our new documentation site for API v2! ..."
tags:
  - "clippings"
---
Welcome to our new documentation site for API v2! This API provides a RESTful
interface for building internal apps, automated workflows, ...
```

## Install

```bash
npm install
```

Node 18+ (tested on 26). Playwright and Chromium are installed, so `--render`
works out of the box. On a fresh clone:

```bash
npm install playwright && npx playwright install chromium
```

## Usage

```bash
node clip.mjs <url> [options]
```

### Clip one page

```bash
node clip.mjs https://developer.affinity.co/pages/external-api-v2/filtering \
  --out "~/Obsidian/Vault/Web Clippings"
```

### Clip a JavaScript-rendered site

Sites that build their content in the browser — Obsidian Publish, most SPA docs
— need `--render`:

```bash
node clip.mjs https://obsidian.md/help/callouts --render --strip-site-suffix \
  --out "~/Obsidian/Vault/Web Clippings/Obsidian"
```

`--strip-site-suffix` trims the `" - Obsidian Help"` tail so the note is called
`Callouts.md`. Rendering costs about 3 seconds per page.

### Crawl a knowledge base

`--crawl` follows the links on the start page — including its sidebar
navigation, which is where a docs site keeps its index — and stays inside
`--scope` (by default, the start URL's own directory).

```bash
node clip.mjs https://developer.affinity.co/pages/external-api-v2/introduction \
  --crawl \
  --out "~/Obsidian/Vault/Web Clippings/Affinity API" \
  --index --wikilinks
```

That produces one note per page, plus an index note that links to all of them,
with the links between pages rewritten as `[[wikilinks]]` so the set works as a
connected folder in the vault.

Always start with `--dry-run` on an unfamiliar site to see what the scope catches:

```bash
node clip.mjs https://example.com/docs/start --crawl --dry-run
```

## Options

### Output

| Option | Effect |
| --- | --- |
| `-o, --out <dir>` | Output directory (default `./clippings`). `~` is expanded. |
| `--tree` | Mirror the site's URL path as subfolders instead of a flat folder. |
| `--index [name]` | Write an index note linking every clipped page. Defaults to the site name. |
| `--wikilinks` | Rewrite links between clipped pages as `[[Note]]` / `[[Note\|text]]`. |
| `--assets` | Download images into `<out>/attachments` and embed them as `![[file.png]]`. |
| `--tags <a,b,c>` | Frontmatter tags (default `clippings`). |
| `--filename <mode>` | Note name from `title` (default), `h1`, or `slug`. |
| `--strip-site-suffix` | Trim `" - Site Name"` / `" \| Site Name"` from titles. |
| `--overwrite` | Replace notes that already exist (default: skip them). |
| `--dry-run` | Report what would be written; write nothing. |

### Crawling

| Option | Effect |
| --- | --- |
| `--crawl` | Follow links from the start page. |
| `--scope <prefix>` | Only crawl URLs starting with this prefix. Default: the start URL's directory. |
| `--depth <n>` | Link depth to follow (default 2). |
| `--limit <n>` | Maximum pages (default 200). |
| `--include <regex>` | Only crawl URLs matching this pattern. Repeatable. |
| `--exclude <regex>` | Never crawl URLs matching this pattern. Repeatable. |
| `--sitemap` | Also seed from the site's `sitemap.xml`. |
| `--allow-offsite` | Allow crawling off the start host. |

### Fetching

| Option | Effect |
| --- | --- |
| `--render` | Render with Playwright, for sites that build their content in the browser. |
| `--concurrency <n>` | Parallel requests (default 3). |
| `--delay <ms>` | Pause between requests (default 400). |
| `--timeout <ms>` | Per-request timeout (default 30000). |
| `--ignore-robots` | Skip the robots.txt check (on by default). |
| `--no-readability` | Convert the main content element directly, skipping Readability. |
| `--user-agent <ua>` | Override the User-Agent header. |

## What the conversion produces

Matched to the reference clippings, not just to Turndown's defaults:

- **Frontmatter** — `title`, `source`, `author`, `published`, `created`,
  `description`, `tags`, in the clipper's order, with empty keys left empty.
  `description` comes from page metadata only; it is never synthesised from the
  article text.
- **Filenames** — vault-illegal characters (`\ / : * ? " < > | # ^ [ ]`) are
  deleted, not substituted, so `Markdown syntax guide | Bitbucket 10.2` becomes
  `Markdown syntax guide  Bitbucket 10.2.md`, double space and all.
- **Lists** — `- item` with two-space nesting, not Turndown's `-   item`.
- **Tables** — GFM pipe tables; tables too complex for Markdown (rowspans,
  block content in cells) are kept as HTML, which is what the extension does.
- **Code** — fenced, with the language detected from `language-*`, `data-lang`,
  and similar. Fences widen to ```` ```` ```` when the code itself contains
  backtick runs.
- **Callouts** — Docusaurus admonitions, Mintlify notes, `data-callout` blocks
  and similar become Obsidian callouts (`> [!warning] Title`), nesting included.
- **Highlights** `==like this==`, **maths** `$inline$` / `$$block$$`,
  **strikethrough**, **task lists**.
- **Inline HTML** Obsidian renders natively (`<sub>`, `<sup>`, `<kbd>`, `<u>`,
  `<abbr>`, `<iframe>`) is preserved.
- **No H1 restating the title** — the title lives in the frontmatter, as in
  every reference clipping.
- Images, lazy-loaded images and `<picture>` resolve to absolute URLs; interface
  icons (declared 24px or smaller) are dropped.

## Fidelity check

The output was diffed against pages the extension itself had clipped — the
Plaid, Bitbucket and Obsidian Help clippings in this vault.

- `plaid.com/docs/auth/coverage/microdeposit-events/`: identical except the clip
  date, one paragraph Plaid edited since, and a trailing section the extension's
  clipping had cut off.
- `obsidian.md/help/embed-web-pages` (rendered): identical except the trailing
  newline.
- The other Obsidian Help pages differ mostly in ways where this tool is more
  faithful to the page (see below).

Where it deliberately differs, because the extension's result is wrong or worse
in Obsidian:

- Code fences widen instead of backslash-escaping nested backticks, so a fenced
  example containing ``` survives intact.
- Task lists keep their checkboxes (`- [x]`), which the extension drops.
- Heading levels are preserved rather than demoted.
- Table column alignment (`:--`, `:-:`, `--:`) is preserved.
- Code block languages are detected in more places.
- Collapsed callouts keep their content instead of losing it.
- Inline `<svg>` is dropped rather than dumped into the note as a wall of path
  data — a rendered Mermaid diagram's source is in the code block above it.
- Trailing whitespace is trimmed, except deliberate two-space line breaks.

## Notes on crawling politely

`robots.txt` is honoured by default, requests are serialised at 3 at a time with
a 400ms pause, and `--limit` caps the run. Raise `--delay` and lower
`--concurrency` on small sites. `--ignore-robots` exists but is yours to justify.

## Layout

```
clip.mjs              CLI: argument parsing, output, assets, wikilinks, index
src/fetch.mjs         HTTP, robots.txt, optional Playwright rendering
src/dom.mjs           DOM normalisation before extraction
src/extract.mjs       Readability + Turndown pipeline for one page
src/markdown.mjs      Turndown configuration and the Obsidian-flavoured rules
src/frontmatter.mjs   Metadata extraction and YAML frontmatter
src/filename.mjs      Vault-safe filenames and uniqueness
src/crawl.mjs         URL scoping, sitemaps, breadth-first queue
```
