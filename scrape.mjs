#!/usr/bin/env node
/**
 * webScraper-MD — clip a page or a whole knowledge base into Obsidian-optimized
 * Markdown, matching the output of the Obsidian Web Clipper browser extension.
 *
 *   node scrape.mjs <url> [options]
 *
 * Run with --help for the full option list.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Fetcher, CHROME_UA } from './src/fetch.mjs';
import { clipPage, collectAllLinks } from './src/extract.mjs';
import { sanitiseFilename, pathFromUrl, uniqueName, safeDecode } from './src/filename.mjs';
import { formatDate, yamlString } from './src/frontmatter.mjs';
import { downloadAsset } from './src/assets.mjs';
import {
  crawl, defaultScope, makeFilter, normaliseUrl, fetchSitemapUrls,
} from './src/crawl.mjs';

const HELP = `
webScraper-MD — web pages and knowledge bases as Obsidian-optimized Markdown

USAGE
  node scrape.mjs <url> [options]

OUTPUT
  -o, --out <dir>          Output directory (default: ./clippings)
      --tree               Mirror the site's URL path as subfolders
      --index [name]       Also write an index note linking every page
                           (default name: the site name, or "Index")
      --wikilinks          Rewrite links between clipped pages as [[wikilinks]]
      --assets             Download images into <out>/attachments and link locally
      --tags <a,b,c>       Frontmatter tags (default: clippings)
      --filename <mode>    Note name from: title | h1 | slug  (default: title)
      --strip-site-suffix  Trim " - Site Name" / " | Site Name" from titles
      --overwrite          Rewrite notes and attachments that already exist (default: skip)
      --dry-run            Report what would be written, write nothing

CRAWLING
      --crawl              Follow links from the start page (an index/sidebar)
      --scope <prefix>     Only crawl URLs starting with this prefix
                           (default: the start URL's directory)
      --depth <n>          Link depth to follow (default: 2)
      --limit <n>          Maximum pages to clip (default: 200)
      --include <regex>    Only crawl URLs matching this pattern (repeatable)
      --exclude <regex>    Never crawl URLs matching this pattern (repeatable)
      --sitemap            Seed the crawl from the site's sitemap.xml
      --allow-offsite      Allow crawling off the start host

FETCHING
      --render             Render with Playwright (for JavaScript-only sites)
      --concurrency <n>    Parallel requests (default: 3)
      --delay <ms>         Pause between requests (default: 400)
      --timeout <ms>       Per-request timeout (default: 30000)
      --ignore-robots      Do not consult robots.txt
      --no-readability     Skip Readability; convert the main content element
      --user-agent <ua>    Override the User-Agent header ("chrome" for a browser string)

EXIT CODES
  0  every page clipped      1  nothing clipped      2  some pages failed

EXAMPLES
  # one page
  node scrape.mjs https://example.com/docs/api/introduction

  # the whole v2 API knowledge base, into a vault folder, with an index
  node scrape.mjs https://example.com/docs/api/introduction \\
    --crawl --out "~/Obsidian/Web Clippings/Example API" --index --wikilinks

  # a JavaScript-rendered site, seeded from its sitemap
  node scrape.mjs https://example.com/docs/ --crawl --render --sitemap --limit 50
`;

function parseArgs(argv) {
  const opts = {
    url: null,
    out: 'clippings',
    tree: false,
    index: null,
    wikilinks: false,
    assets: false,
    tags: ['clippings'],
    filename: 'title',
    stripTitleSuffix: false,
    overwrite: false,
    dryRun: false,
    crawl: false,
    scope: null,
    depth: 2,
    limit: 200,
    include: [],
    exclude: [],
    sitemap: false,
    sameOrigin: true,
    render: false,
    concurrency: 3,
    delay: 400,
    timeout: 30000,
    respectRobots: true,
    readability: true,
    userAgent: undefined,
  };

  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    const next = () => {
      const value = args.shift();
      if (value === undefined) fail(`Missing value for ${arg}`);
      return value;
    };
    /** A numeric flag value, or a clear failure. Never NaN. */
    const num = ({ min = 0, integer = true } = {}) => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
        fail(`${arg} needs ${integer ? 'a whole number' : 'a number'}${min > 0 ? ` of at least ${min}` : ''}, got "${raw}"`);
      }
      return n;
    };

    switch (arg) {
      case '-h': case '--help': console.log(HELP.trim()); process.exit(0); break;
      case '-o': case '--out': opts.out = next(); break;
      case '--tree': opts.tree = true; break;
      case '--index':
        opts.index = (args[0] && !args[0].startsWith('-')) ? args.shift() : true;
        break;
      case '--wikilinks': opts.wikilinks = true; break;
      case '--assets': opts.assets = true; break;
      case '--tags': opts.tags = next().split(',').map((t) => t.trim()).filter(Boolean); break;
      case '--filename': opts.filename = next(); break;
      case '--strip-site-suffix': opts.stripTitleSuffix = true; break;
      case '--overwrite': opts.overwrite = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--crawl': opts.crawl = true; break;
      case '--scope': opts.scope = next(); break;
      case '--depth': opts.depth = num(); break;
      case '--limit': opts.limit = num({ min: 1 }); break;
      case '--include': opts.include.push(next()); break;
      case '--exclude': opts.exclude.push(next()); break;
      case '--sitemap': opts.sitemap = true; break;
      case '--allow-offsite': case '--same-origin=false': opts.sameOrigin = false; break;
      case '--render': opts.render = true; break;
      case '--concurrency': opts.concurrency = num({ min: 1 }); break;
      case '--delay': opts.delay = num({ integer: false }); break;
      case '--timeout': opts.timeout = num({ min: 1 }); break;
      case '--ignore-robots': opts.respectRobots = false; break;
      case '--no-readability': opts.readability = false; break;
      case '--user-agent': {
        const ua = next();
        opts.userAgent = ua.toLowerCase() === 'chrome' ? CHROME_UA : ua;
        break;
      }
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        else if (!opts.url) opts.url = arg;
        else fail(`Unexpected argument: ${arg}`);
    }
  }

  if (!opts.url) fail('A start URL is required.\n\n' + HELP.trim());
  if (!/^https?:\/\//i.test(opts.url)) opts.url = `https://${opts.url}`;
  try { new URL(opts.url); } catch { fail(`Not a valid URL: ${opts.url}`); }
  if (!['title', 'h1', 'slug'].includes(opts.filename)) fail(`--filename must be title, h1, or slug`);
  for (const pattern of [...opts.include, ...opts.exclude]) {
    try { new RegExp(pattern, 'i'); } catch (error) { fail(`Bad pattern "${pattern}": ${error.message}`); }
  }
  return opts;
}

function fail(message) {
  console.error(`webScraper-MD: ${message}`);
  process.exit(1);
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Note name for a page, per --filename mode. */
function noteNameFor(meta, url, mode) {
  if (mode === 'h1' && meta.h1) return sanitiseFilename(meta.h1);
  if (mode === 'slug') {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segments.pop() || new URL(url).hostname;
    return sanitiseFilename(safeDecode(slug.replace(/\.(html?|php|aspx?)$/i, '')));
  }
  return sanitiseFilename(meta.title || meta.h1 || url);
}

/**
 * Rewrite absolute links that point at other clipped pages into wikilinks.
 * `[text](url)` -> `[[Note]]` when the text is the note name, else `[[Note|text]]`.
 */
function applyWikilinks(markdown, urlToNote, selfUrl) {
  return markdown.replace(/\[([^\]]*)\]\((<[^>]+>|[^()\s]+)(?:\s+"[^"]*")?\)/g, (match, text, rawHref) => {
    const href = rawHref.replace(/^<|>$/g, '');
    if (!/^https?:\/\//i.test(href)) return match;
    const [base, fragment] = href.split('#');
    const key = normaliseUrl(base);
    if (!key) return match;
    const note = urlToNote.get(key);
    if (!note) return match;
    if (key === normaliseUrl(selfUrl) && fragment) return `[${text}](#${fragment})`;
    const heading = fragment ? `#${safeDecode(fragment).replace(/[|#^[\]]/g, ' ')}` : '';
    const label = text.trim();
    if (!label || label === note) return `[[${note}${heading}]]`;
    return `[[${note}${heading}|${label}]]`;
  });
}

function buildIndexNote({ name, startUrl, pages, tags, site }) {
  const created = formatDate();
  const siteName = site || new URL(startUrl).hostname;
  const lines = [
    '---',
    `title: ${yamlString(name)}`,
    `source: ${yamlString(startUrl)}`,
    'author:',
    'published:',
    `created: ${created}`,
    `description: ${yamlString(`Index of ${pages.length} page${pages.length === 1 ? '' : 's'} clipped from ${siteName}`)}`,
    'tags:',
    ...tags.map((tag) => `  - ${yamlString(tag)}`),
    '  - "index"',
    '---',
    `# ${name}`,
    '',
    `Clipped from [${siteName}](${startUrl}) on ${created}.`,
    '',
  ];

  // Group by the folder each note landed in, so --tree runs read sensibly.
  const groups = new Map();
  for (const page of pages) {
    const group = page.folder || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(page);
  }

  for (const [group, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group) lines.push(`## ${group}`, '');
    for (const page of items) {
      const note = page.note;
      const summary = page.description ? ` — ${page.description}` : '';
      lines.push(`- [[${note}]]${summary}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(expandHome(opts.out));
  const attachmentsDir = path.join(outDir, 'attachments');

  const fetcher = new Fetcher({
    userAgent: opts.userAgent,
    timeout: opts.timeout,
    render: opts.render,
    respectRobots: opts.respectRobots,
  });

  const scope = opts.scope || (opts.crawl ? defaultScope(opts.url) : null);
  const accepts = makeFilter({
    scope,
    sameOrigin: opts.sameOrigin,
    include: opts.include,
    exclude: opts.exclude,
    startUrl: opts.url,
  });

  const takenNotes = new Set();
  const takenAssets = new Set();
  const clipped = [];   // { url, key, note, folder, file, markdown, description, site }
  const failures = [];  // { url, error }
  const now = new Date();
  let assetsSkipped = 0;

  const onError = (url, error) => {
    failures.push({ url, error: error.message });
    process.stderr.write(`  ! ${url} — ${error.message}\n`);
  };

  const startUrls = [opts.url];
  if (opts.crawl && opts.sitemap) {
    const origin = new URL(opts.url).origin;
    process.stderr.write('Reading sitemap...\n');
    const sitemapUrls = await fetchSitemapUrls(fetcher, origin, { onError });
    const seeded = sitemapUrls.map((u) => normaliseUrl(u)).filter((u) => u && accepts(u));
    process.stderr.write(`  ${seeded.length} in-scope URL${seeded.length === 1 ? '' : 's'} from sitemap\n`);
    startUrls.push(...seeded);
  }

  if (!opts.dryRun) await fs.mkdir(outDir, { recursive: true });

  // --- Writing -------------------------------------------------------------
  // Notes are held until the crawl ends so --wikilinks can see every page. To
  // make that safe, the same writer runs on Ctrl-C and on a crash, so a long
  // crawl never ends with nothing on disk.
  const writeNotes = async (pages, { wikilinks }) => {
    if (wikilinks) {
      const urlToNote = new Map(pages.map((page) => [page.key, page.note]));
      for (const page of pages) page.markdown = applyWikilinks(page.markdown, urlToNote, page.url);
    }
    let written = 0;
    let skipped = 0;
    for (const page of pages) {
      if (page.written !== undefined) { if (page.written) written += 1; else skipped += 1; continue; }
      if (opts.dryRun) continue;
      try {
        await fs.mkdir(path.dirname(page.file), { recursive: true });
        if (!opts.overwrite && await exists(page.file)) {
          page.written = false;
          skipped += 1;
          continue;
        }
        await fs.writeFile(page.file, page.markdown, 'utf8');
        page.written = true;
        written += 1;
      } catch (error) {
        onError(page.url, Object.assign(error, { message: `write: ${error.message}` }));
      }
    }
    return { written, skipped };
  };

  let interrupted = false;
  process.once('SIGINT', async () => {
    interrupted = true;
    process.stderr.write(`\nInterrupted. Writing the ${clipped.length} page(s) clipped so far...\n`);
    await fetcher.close().catch(() => {});
    const { written } = await writeNotes([...clipped], { wikilinks: false });
    process.stderr.write(`Wrote ${written} note(s) to ${outDir}\n`);
    await flushOutput();
    process.exit(130);
  });

  const handlePage = async (url, html) => {
    if (interrupted) return { links: [] };
    const result = clipPage(html, url, {
      tags: opts.tags,
      now,
      stripTitleSuffix: opts.stripTitleSuffix,
      readability: opts.readability,
      wikilinkEmbeds: opts.assets,
    });

    let { markdown } = result;
    const { meta, images } = result;

    if (opts.assets && images.length) {
      const map = new Map();
      for (const src of images) {
        try {
          const { name } = await downloadAsset(src, {
            dir: attachmentsDir,
            taken: takenAssets,
            userAgent: fetcher.userAgent,
            timeout: opts.timeout,
            dryRun: opts.dryRun,
            overwrite: opts.overwrite,
          });
          map.set(src, name);
        } catch (error) {
          if (error.skip) {
            assetsSkipped += 1; // left as a remote link; not a failure
          } else {
            failures.push({ url: src, error: `asset: ${error.message}` });
          }
        }
      }
      markdown = markdown.replace(/!\[([^\]]*)\]\((<[^>]+>|[^()\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, rawSrc) => {
        const src = rawSrc.replace(/^<|>$/g, '');
        const local = map.get(src);
        return local ? `![[${local}]]` : match;
      });
    }

    const folderSegments = opts.tree ? pathFromUrl(url, scope) : [];
    const note = uniqueName(noteNameFor(meta, url, opts.filename), takenNotes);
    const file = path.join(outDir, ...folderSegments, `${note}.md`);

    clipped.push({
      url,
      key: normaliseUrl(url),
      note,
      folder: folderSegments.join('/'),
      file,
      markdown,
      description: meta.description,
      site: meta.site,
    });

    process.stderr.write(`  + ${note}\n`);
    // The crawler wants every link on the page, not just the article's.
    return { links: result.allLinks ?? collectAllLinks(html, url) };
  };

  process.stderr.write(`${opts.crawl ? 'Crawling' : 'Clipping'} ${opts.url}\n`);
  if (opts.crawl) process.stderr.write(`  scope: ${scope}  depth: ${opts.depth}  limit: ${opts.limit}\n`);

  try {
    if (opts.crawl) {
      await crawl({
        fetcher,
        startUrls,
        accepts,
        maxDepth: opts.depth,
        maxPages: opts.limit,
        concurrency: opts.concurrency,
        delay: opts.delay,
        onPage: handlePage,
        onError,
      });
    } else {
      try {
        const { html, finalUrl } = await fetcher.getHtml(opts.url);
        await handlePage(finalUrl || opts.url, html);
      } catch (error) {
        onError(opts.url, error);
      }
    }
  } catch (error) {
    // The crawler itself failed. Save what we have before reporting.
    process.stderr.write(`\nCrawl aborted: ${error.message}\n`);
    await fetcher.close().catch(() => {});
    const { written } = await writeNotes([...clipped], { wikilinks: false });
    process.stderr.write(`Wrote ${written} note(s) to ${outDir} before the failure\n`);
    throw error;
  } finally {
    await fetcher.close();
  }
  if (interrupted) return;

  const { written: notesWritten, skipped } = await writeNotes(clipped, { wikilinks: opts.wikilinks });
  let written = notesWritten;

  if (opts.index && clipped.length) {
    const site = clipped[0].site;
    const name = sanitiseFilename(
      typeof opts.index === 'string' ? opts.index : (site || `${new URL(opts.url).hostname} Index`),
    );
    const indexPath = path.join(outDir, `${name}.md`);
    const contents = buildIndexNote({
      name, startUrl: opts.url, pages: clipped, tags: opts.tags, site,
    });
    if (opts.dryRun) {
      process.stderr.write(`  = index: ${name}.md\n`);
    } else if (!opts.overwrite && await exists(indexPath)) {
      process.stderr.write(`  = index: ${name}.md already exists; --overwrite to replace\n`);
    } else {
      await fs.writeFile(indexPath, contents, 'utf8');
      written += 1;
      process.stderr.write(`  = index: ${name}.md\n`);
    }
  }

  process.stderr.write('\n');
  process.stderr.write(
    opts.dryRun
      ? `Dry run: ${clipped.length} page(s) would be written to ${outDir}\n`
      : `Wrote ${written} note(s) to ${outDir}${skipped ? ` (${skipped} already existed; --overwrite to replace)` : ''}\n`,
  );
  if (assetsSkipped) process.stderr.write(`${assetsSkipped} image link(s) left remote (not an image, or a private host)\n`);
  if (failures.length) {
    process.stderr.write(`${failures.length} failure(s):\n`);
    const shown = failures.slice(0, 20);
    for (const failure of shown) process.stderr.write(`  ${failure.url} — ${failure.error}\n`);
    if (failures.length > shown.length) process.stderr.write(`  ...and ${failures.length - shown.length} more\n`);
  }

  // Playwright can leave handles behind after a long run, which keeps Node
  // alive long after the clip is written. Everything is on disk by now, so
  // flush the output and exit rather than waiting on the event loop.
  await flushOutput();
  if (!clipped.length) process.exit(1);
  process.exit(failures.length ? 2 : 0);
}

/** Wait for stderr/stdout to drain so nothing is lost to process.exit(). */
function flushOutput() {
  const drain = (stream) => new Promise((resolve) => {
    if (stream.writableLength === 0) resolve();
    else stream.write('', resolve);
  });
  return Promise.all([drain(process.stderr), drain(process.stdout)]);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

main().catch(async (error) => {
  console.error(`webScraper-MD: ${error.stack || error.message}`);
  await flushOutput();
  process.exit(1);
});
