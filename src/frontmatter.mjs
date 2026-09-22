/**
 * Metadata extraction and YAML frontmatter, byte-compatible with the
 * Obsidian Web Clipper's default template:
 *
 *   ---
 *   title: "..."
 *   source: "..."
 *   author:
 *   published:
 *   created: YYYY-MM-DD
 *   description: "..."
 *   tags:
 *     - "clippings"
 *   ---
 *
 * Fields the page does not supply are written as empty keys, not omitted.
 */

const META_LOOKUPS = {
  title: [
    ['meta[property="og:title"]', 'content'],
    ['meta[name="twitter:title"]', 'content'],
    ['meta[name="title"]', 'content'],
  ],
  description: [
    ['meta[property="og:description"]', 'content'],
    ['meta[name="description"]', 'content'],
    ['meta[name="twitter:description"]', 'content'],
  ],
  author: [
    ['meta[name="author"]', 'content'],
    ['meta[property="article:author"]', 'content'],
    ['meta[name="byl"]', 'content'],
    ['meta[name="parsely-author"]', 'content'],
    ['meta[property="book:author"]', 'content'],
    ['[itemprop="author"] [itemprop="name"]', 'text'],
    ['[rel="author"]', 'text'],
  ],
  published: [
    ['meta[property="article:published_time"]', 'content'],
    ['meta[name="article:published_time"]', 'content'],
    ['meta[name="date"]', 'content'],
    ['meta[name="parsely-pub-date"]', 'content'],
    ['meta[itemprop="datePublished"]', 'content'],
    ['time[datetime]', 'datetime'],
  ],
  site: [
    ['meta[property="og:site_name"]', 'content'],
  ],
};

function readMeta(doc, key) {
  for (const [selector, attr] of META_LOOKUPS[key] || []) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const value = attr === 'text' ? el.textContent : el.getAttribute(attr);
    const trimmed = (value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Pull author/date/description out of JSON-LD when the meta tags are silent. */
function readJsonLd(doc) {
  const out = {};
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!out.author && node.author) {
        const author = Array.isArray(node.author) ? node.author[0] : node.author;
        out.author = typeof author === 'string' ? author : (author?.name || '');
      }
      if (!out.published && (node.datePublished || node.dateCreated)) {
        out.published = node.datePublished || node.dateCreated;
      }
      if (!out.description && node.description) out.description = node.description;
      if (!out.title && node.headline) out.title = node.headline;
    }
  }
  return out;
}

/** ISO timestamps become plain dates; anything unparseable is passed through. */
function toDate(value) {
  if (!value) return '';
  // Collapse first: a newline in a <meta> value must never reach the YAML.
  const clean = collapse(String(value));
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(clean);
  if (iso) return iso[1];
  const parsed = new Date(clean);
  if (!Number.isNaN(parsed.getTime())) return formatDate(parsed);
  return clean;
}

export function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Collect the frontmatter fields for a page.
 * `article` is the Readability result (may be null).
 */
export function extractMetadata(doc, url, article, options = {}) {
  const jsonLd = readJsonLd(doc);

  const documentTitle = (doc.title || '').trim();
  const h1 = doc.querySelector('h1')?.textContent?.trim() || '';
  let title = readMeta(doc, 'title') || documentTitle || jsonLd.title || article?.title || h1 || url;

  if (options.stripTitleSuffix) {
    // "Page - Site Name" / "Page | Site Name" -> "Page", but only when the
    // tail really is the site name.
    const site = readMeta(doc, 'site');
    if (site) {
      const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\s*[|\\-–—·»]\\s*${escaped}\\s*$`, 'i');
      title = title.replace(pattern, '').trim() || title;
    }
  }

  // Only real page metadata: the clipper leaves `description` empty rather than
  // synthesising one from the article text.
  const description = readMeta(doc, 'description') || jsonLd.description || '';

  return {
    title: collapse(title),
    source: url,
    author: collapse(readMeta(doc, 'author') || jsonLd.author || article?.byline || ''),
    published: toDate(readMeta(doc, 'published') || jsonLd.published || ''),
    created: formatDate(options.now || new Date()),
    description: collapse(description),
    h1: collapse(h1),
    site: collapse(readMeta(doc, 'site')),
  };
}

function collapse(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/** Quote a scalar the way the clipper does: always double-quoted, escaped. */
export function yamlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildFrontmatter(meta, tags = ['clippings'], extra = {}) {
  const lines = ['---'];
  lines.push(`title: ${meta.title ? yamlString(meta.title) : ''}`.trimEnd());
  lines.push(`source: ${meta.source ? yamlString(meta.source) : ''}`.trimEnd());
  lines.push(`author: ${meta.author ? yamlString(meta.author) : ''}`.trimEnd());
  // A plain date stays bare so Obsidian reads it as a date property; anything
  // else is quoted so page metadata can never add keys to the frontmatter.
  const published = meta.published || '';
  lines.push(`published: ${PLAIN_DATE.test(published) ? published : (published ? yamlString(published) : '')}`.trimEnd());
  lines.push(`created: ${meta.created}`);
  lines.push(`description: ${meta.description ? yamlString(meta.description) : ''}`.trimEnd());
  lines.push('tags:');
  for (const tag of tags) lines.push(`  - ${yamlString(tag)}`);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${typeof value === 'number' ? value : yamlString(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}
