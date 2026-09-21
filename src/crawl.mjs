/**
 * Knowledge-base crawling: URL normalisation, scoping, sitemap discovery, and
 * a breadth-first queue with a concurrency limit and a politeness delay.
 *
 * Link discovery deliberately reads the whole page rather than the extracted
 * article, because a docs site's index lives in its sidebar navigation.
 */

import { collectAllLinks } from './extract.mjs';
import { sleep } from './fetch.mjs';

/** Extensions that are never pages worth clipping. */
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4a|wav|ogg|webm|mov|avi|zip|gz|tgz|bz2|7z|rar|pdf|docx?|xlsx?|pptx?|csv|json|ya?ml|xml|txt|rss|atom|css|js|mjs|map|woff2?|ttf|eot|exe|dmg|pkg|deb|rpm)$/i;

/**
 * Canonical form for dedup: drop the fragment, drop tracking params, and
 * normalise a trailing slash. Query strings that look meaningful are kept.
 */
export function normaliseUrl(input, { keepQuery = true } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  for (const param of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source|_ga)/i.test(param)) url.searchParams.delete(param);
  }
  if (!keepQuery) url.search = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.hostname = url.hostname.replace(/^www\./, '');
  return url.href;
}

/** Default scope: everything under the start URL's directory. */
export function defaultScope(startUrl) {
  const url = new URL(startUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 1) segments.pop();
  const path = segments.length ? `/${segments.join('/')}/` : '/';
  return `${url.origin}${path}`;
}

export function makeFilter({ scope, sameOrigin = true, include = [], exclude = [], startUrl }) {
  const start = new URL(startUrl);
  const scopeUrl = scope ? new URL(scope) : null;
  const includeRe = include.map((p) => new RegExp(p, 'i'));
  const excludeRe = exclude.map((p) => new RegExp(p, 'i'));

  return function accepts(rawUrl) {
    const url = (() => {
      try { return new URL(rawUrl); } catch { return null; }
    })();
    if (!url) return false;
    if (SKIP_EXTENSIONS.test(url.pathname)) return false;
    if (sameOrigin && url.hostname.replace(/^www\./, '') !== start.hostname.replace(/^www\./, '')) return false;
    if (scopeUrl) {
      const inScope = url.href.startsWith(scopeUrl.href)
        || url.href === scopeUrl.href.replace(/\/$/, '');
      if (!inScope) return false;
    }
    if (excludeRe.some((re) => re.test(url.href))) return false;
    if (includeRe.length && !includeRe.some((re) => re.test(url.href))) return false;
    return true;
  };
}

/** Pull page URLs out of sitemap.xml, following sitemap indexes one level. */
export async function fetchSitemapUrls(fetcher, origin, { depth = 1 } = {}) {
  const found = new Set();
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set();

  for (let level = 0; level <= depth && queue.length; level += 1) {
    const batch = queue.splice(0, queue.length);
    for (const sitemapUrl of batch) {
      if (seen.has(sitemapUrl)) continue;
      seen.add(sitemapUrl);
      let xml;
      try {
        // Sitemaps are served as XML, which the HTML content-type guard rejects.
        ({ html: xml } = await fetcher.fetchHtml(sitemapUrl, { acceptAnyType: true }));
      } catch {
        continue;
      }
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      const isIndex = /<sitemapindex/i.test(xml);
      for (const loc of locs) {
        if (isIndex) queue.push(loc);
        else found.add(loc);
      }
    }
  }
  return [...found];
}

/**
 * Breadth-first crawl.
 *
 * `onPage(url, html, depth)` is awaited for every fetched page and returns the
 * links to consider next (or undefined to use the page's own links).
 */
export async function crawl({
  fetcher,
  startUrls,
  accepts,
  maxDepth = 2,
  maxPages = 200,
  concurrency = 3,
  delay = 400,
  onPage,
  onError,
}) {
  const seen = new Set();
  const results = [];
  let claimed = 0;
  let queue = [];

  for (const url of startUrls) {
    const key = normaliseUrl(url);
    if (key && !seen.has(key)) {
      seen.add(key);
      queue.push({ url, depth: 0 });
    }
  }

  for (let depth = 0; depth <= maxDepth && queue.length && claimed < maxPages; depth += 1) {
    const level = queue;
    queue = [];

    const discovered = [];
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        // Claim a slot before fetching, so N parallel workers cannot together
        // overshoot maxPages.
        if (cursor >= level.length || claimed >= maxPages) return;
        const item = level[cursor];
        cursor += 1;
        claimed += 1;
        try {
          const { html, finalUrl } = await fetcher.getHtml(item.url);
          const outcome = await onPage(finalUrl || item.url, html, item.depth);
          results.push({ url: finalUrl || item.url, depth: item.depth });
          const links = outcome?.links ?? collectAllLinks(html, finalUrl || item.url);
          for (const link of links) discovered.push(link);
        } catch (error) {
          claimed -= 1; // a failure does not consume a page slot
          onError?.(item.url, error);
        }
        if (delay) await sleep(delay);
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

    if (depth < maxDepth) {
      for (const link of discovered) {
        const key = normaliseUrl(link);
        if (!key || seen.has(key)) continue;
        if (!accepts(key)) continue;
        seen.add(key);
        queue.push({ url: key, depth: depth + 1 });
      }
    }
  }

  return results;
}
