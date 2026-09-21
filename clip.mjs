#!/usr/bin/env node
/**
 * kb-clip — clip a page or a whole knowledge base into Obsidian-optimized
 * Markdown, matching the output of the Obsidian Web Clipper browser extension.
 *
 *   node clip.mjs <url> [options]
 *
 * Run with --help for the full option list.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { Fetcher } from './src/fetch.mjs';
import { clipPage, collectAllLinks } from './src/extract.mjs';
import { sanitiseFilename, pathFromUrl, uniqueName } from './src/filename.mjs';
import { formatDate } from './src/frontmatter.mjs';
import {
  crawl, defaultScope, makeFilter, normaliseUrl, fetchSitemapUrls,
} from './src/crawl.mjs';

const HELP = `
kb-clip — web pages and knowledge bases as Obsidian-optimized Markdown

USAGE
  node clip.mjs <url> [options]

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
      --overwrite          Rewrite notes that already exist (default: skip)
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
      --user-agent <ua>    Override the User-Agent header

EXAMPLES
  # one page
  node clip.mjs https://developer.affinity.co/pages/external-api-v2/introduction

  # the whole Affinity v2 API knowledge base, into a vault folder, with an index
  node clip.mjs https://developer.affinity.co/pages/external-api-v2/introduction \\
    --crawl --out "~/Obsidian/Web Clippings/Affinity API" --index --wikilinks

  # a JavaScript-rendered site, seeded from its sitemap
  node clip.mjs https://example.com/docs/ --crawl --render --sitemap --limit 50
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
      case '--depth': opts.depth = Number(next()); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--include': opts.include.push(next()); break;
      case '--exclude': opts.exclude.push(next()); break;
      case '--sitemap': opts.sitemap = true; break;
      case '--allow-offsite': case '--same-origin=false': opts.sameOrigin = false; break;
      case '--render': opts.render = true; break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--delay': opts.delay = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--ignore-robots': opts.respectRobots = false; break;
      case '--no-readability': opts.readability = false; break;
      case '--user-agent': opts.userAgent = next(); break;
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        else if (!opts.url) opts.url = arg;
        else fail(`Unexpected argument: ${arg}`);
    }
  }

  if (!opts.url) fail('A start URL is required.\n\n' + HELP.trim());
  if (!/^https?:\/\//i.test(opts.url)) opts.url = `https://${opts.url}`;
  if (!['title', 'h1', 'slug'].includes(opts.filename)) fail(`--filename must be title, h1, or slug`);
  return opts;
}

function fail(message) {
  console.error(`kb-clip: ${message}`);
  process.exit(1);
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p;
}

/** Note name for a page, per --filename mode. */
function noteNameFor(meta, url, mode) {
  if (mode === 'h1' && meta.h1) return sanitiseFilename(meta.h1);
  if (mode === 'slug') {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segments.pop() || new URL(url).hostname;
    return sanitiseFilename(decodeURIComponent(slug.replace(/\.(html?|php|aspx?)$/i, '')));
  }
  return sanitiseFilename(meta.title || meta.h1 || url);
}

/** Download an image into <out>/attachments, returning its local filename. */
async function downloadAsset(fetcher, src, attachmentsDir, taken, dryRun) {
  const url = new URL(src);
  const base = decodeURIComponent(path.basename(url.pathname)) || 'image';
  const ext = path.extname(base) || '.png';
  const stem = sanitiseFilename(path.basename(base, path.extname(base)) || 'image', { maxLength: 96 });
  const name = uniqueName(`${stem}${ext}`, taken);

  if (dryRun) return name;

  const response = await fetch(src, { headers: { 'User-Agent': fetcher.userAgent } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(attachmentsDir, { recursive: true });
  await fs.writeFile(path.join(attachmentsDir, name), buffer);
  return name;
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
    const heading = fragment ? `#${decodeURIComponent(fragment).replace(/[|#^[\]]/g, ' ')}` : '';
    const label = text.trim();
    if (!label || label === note) return `[[${note}${heading}]]`;
    return `[[${note}${heading}|${label}]]`;
  });
}

function buildIndexNote({ name, startUrl, pages, tags, site }) {
  const created = formatDate();
  const lines = [
    '---',
    `title: "${name}"`,
    `source: "${startUrl}"`,
    'author:',
    'published:',
    `created: ${created}`,
    `description: "Index of ${pages.length} page${pages.length === 1 ? '' : 's'} clipped from ${site || new URL(startUrl).hostname}"`,
    'tags:',
    ...tags.map((tag) => `  - "${tag}"`),
    '  - "index"',
    '---',
    `# ${name}`,
    '',
    `Clipped from [${site || new URL(startUrl).hostname}](${startUrl}) on ${created}.`,
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

  const startUrls = [opts.url];
  if (opts.crawl && opts.sitemap) {
    const origin = new URL(opts.url).origin;
    process.stderr.write('Reading sitemap...\n');
    const sitemapUrls = await fetchSitemapUrls(fetcher, origin);
    const seeded = sitemapUrls.map((u) => normaliseUrl(u)).filter((u) => u && accepts(u));
    process.stderr.write(`  ${seeded.length} in-scope URL${seeded.length === 1 ? '' : 's'} from sitemap\n`);
    startUrls.push(...seeded);
  }

  if (!opts.dryRun) await fs.mkdir(outDir, { recursive: true });

  const takenNotes = new Set();
  const takenAssets = new Set();
  const clipped = [];   // { url, note, folder, file, markdown, description }
  const failures = [];
  const now = new Date();

  const handlePage = async (url, html) => {
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
          map.set(src, await downloadAsset(fetcher, src, attachmentsDir, takenAssets, opts.dryRun));
        } catch (error) {
          failures.push({ url: src, error: `asset: ${error.message}` });
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
    return { links: collectAllLinks(html, url) };
  };

  const onError = (url, error) => {
    failures.push({ url, error: error.message });
    process.stderr.write(`  ! ${url} — ${error.message}\n`);
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
  } finally {
    await fetcher.close();
  }

  // --- Cross-linking and writing -------------------------------------------
  if (opts.wikilinks) {
    const urlToNote = new Map(clipped.map((page) => [page.key, page.note]));
    for (const page of clipped) {
      page.markdown = applyWikilinks(page.markdown, urlToNote, page.url);
    }
  }

  let written = 0;
  let skipped = 0;
  for (const page of clipped) {
    if (opts.dryRun) continue;
    await fs.mkdir(path.dirname(page.file), { recursive: true });
    if (!opts.overwrite && await exists(page.file)) {
      skipped += 1;
      continue;
    }
    await fs.writeFile(page.file, page.markdown, 'utf8');
    written += 1;
  }

  if (opts.index && clipped.length) {
    const site = clipped[0].site;
    const name = sanitiseFilename(
      typeof opts.index === 'string' ? opts.index : (site || `${new URL(opts.url).hostname} Index`),
    );
    const indexPath = path.join(outDir, `${name}.md`);
    const contents = buildIndexNote({
      name, startUrl: opts.url, pages: clipped, tags: opts.tags, site,
    });
    if (!opts.dryRun) {
      await fs.writeFile(indexPath, contents, 'utf8');
      written += 1;
    }
    process.stderr.write(`  = index: ${name}.md\n`);
  }

  process.stderr.write('\n');
  process.stderr.write(
    opts.dryRun
      ? `Dry run: ${clipped.length} page(s) would be written to ${outDir}\n`
      : `Wrote ${written} note(s) to ${outDir}${skipped ? ` (${skipped} already existed; --overwrite to replace)` : ''}\n`,
  );
  if (failures.length) {
    process.stderr.write(`${failures.length} failure(s):\n`);
    for (const failure of failures.slice(0, 20)) {
      process.stderr.write(`  ${failure.url} — ${failure.error}\n`);
    }
  }
  if (!clipped.length) process.exit(1);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`kb-clip: ${error.stack || error.message}`);
  process.exit(1);
});
