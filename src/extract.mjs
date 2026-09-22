/**
 * HTML -> Obsidian Markdown.
 *
 * Mirrors the Obsidian Web Clipper's pipeline: normalise the DOM, let
 * Readability pick the article, convert with Turndown + GFM, then prepend the
 * clipper's frontmatter template.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';

import { preprocess } from './dom.mjs';
import { createTurndown, tidyMarkdown } from './markdown.mjs';
import { extractMetadata, buildFrontmatter } from './frontmatter.mjs';

/**
 * Containers that unambiguously wrap rendered Markdown and nothing else.
 * Only these are trusted enough to override Readability's pick.
 */
const RENDERED_MARKDOWN_SELECTORS = [
  '.markdown-preview-view',
  '.markdown-rendered',
  '.markdown-body',
  '.theme-doc-markdown',
  '.mdx-content',
];

/** Broader containers, used only when Readability comes back empty. */
const CONTENT_SELECTORS = [
  ...RENDERED_MARKDOWN_SELECTORS,
  'article',
  'main article',
  '[role="main"]',
  'main',
  '#content-area',
  '#content',
  '.doc-content',
  '.prose',
  '.content',
  'body',
];

const MIN_CONTENT_LENGTH = 200;

/**
 * A rendered-Markdown container is preferred unless it holds materially less
 * than Readability found (which would mean we picked the wrong element), and
 * unless it is mostly links.
 */
const MIN_CONTAINER_COVERAGE = 0.9;
const MAX_CONTAINER_LINK_DENSITY = 0.35;

export function parseDocument(html, url) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {}); // CSS parse noise is not our problem
  return new JSDOM(html, { url, virtualConsole });
}

/**
 * Choose the article body. Readability first — it is what the clipper uses —
 * with a selector-based fallback for pages it scores badly (short reference
 * pages, API tables, heavily componentised docs).
 */
function selectContent(doc, url, { readability = true } = {}) {
  const container = findContainer(doc);

  let article = null;
  if (readability) {
    try {
      article = new Readability(doc.cloneNode(true), {
        charThreshold: 250,
        keepClasses: true, // our callout/code rules read classes downstream
      }).parse();
    } catch { /* fall through to the container */ }
  }

  const articleLength = article?.textContent ? textLength(article.textContent) : 0;

  if (article?.content && articleLength >= MIN_CONTENT_LENGTH) {
    // Readability drops short, structured blocks — a title-only callout, a
    // collapsed admonition, a lone code sample — because they score as
    // boilerplate next to the surrounding prose. When the page hands us a
    // container that is by definition nothing but rendered Markdown, finding
    // the article is already done, so use it and keep those blocks. A page
    // whose generic "content" element also wraps its sidebar is not one of
    // these, and still gets Readability's cleaner result.
    if (container
      && container.rendered
      && container.length >= articleLength * MIN_CONTAINER_COVERAGE
      && linkDensity(container.el) < MAX_CONTAINER_LINK_DENSITY) {
      return { article, html: container.el.innerHTML };
    }
    return { article, html: article.content };
  }

  if (container) return { article, html: container.el.innerHTML };

  if (article?.content && !isProbablyReaderable(doc)) {
    // Short but genuine (a stub page): Readability's pick is still the best one.
    return { article, html: article.content };
  }

  const body = doc.body;
  return { article, html: body ? body.innerHTML : '' };
}

/** The most specific content container that actually holds the page's text. */
function findContainer(doc) {
  for (const selector of CONTENT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const length = textLength(el.textContent);
    if (length >= MIN_CONTENT_LENGTH) {
      return { el, length, selector, rendered: RENDERED_MARKDOWN_SELECTORS.includes(selector) };
    }
  }
  return null;
}

/** Fraction of an element's text that sits inside links. */
function linkDensity(el) {
  const total = textLength(el.textContent);
  if (!total) return 1;
  let linked = 0;
  for (const a of el.querySelectorAll('a[href]')) linked += textLength(a.textContent);
  return linked / total;
}

function textLength(text) {
  return (text || '').replace(/\s+/g, ' ').trim().length;
}

/**
 * Clip one page.
 *
 * @param {string} html      raw HTML
 * @param {string} url       the URL it came from (used as base and as `source`)
 * @param {object} options   { tags, now, stripTitleSuffix, readability, wikilinkEmbeds }
 * @returns {{markdown: string, body: string, meta: object, links: string[], images: string[], allLinks: string[]}}
 */
export function clipPage(html, url, options = {}) {
  const {
    tags = ['clippings'],
    now = new Date(),
    stripTitleSuffix = false,
    readability = true,
    wikilinkEmbeds = false,
    extraFrontmatter = {},
  } = options;

  const dom = parseDocument(html, url);
  const doc = dom.window.document;

  // Metadata comes off the untouched document; preprocessing removes <meta>.
  const preMeta = { doc: doc.cloneNode(true) };

  // Every link on the untouched page, for the crawler: a docs site keeps its
  // index in the sidebar, which preprocessing and Readability both remove.
  const allLinks = collectLinks(doc, url);

  preprocess(doc, url);

  const { article, html: contentHtml } = selectContent(doc, url, { readability });
  const meta = extractMetadata(preMeta.doc, url, article, { now, stripTitleSuffix });

  // Run the extracted fragment through preprocessing once more: Readability
  // rebuilds nodes, and our data-wsmd-* markers must survive into Turndown.
  const fragment = parseDocument(`<body>${contentHtml}</body>`, url);
  preprocess(fragment.window.document, url);
  dropRedundantTitle(fragment.window.document, meta);

  const td = createTurndown({ wikilinkEmbeds });
  const body = tidyMarkdown(td.turndown(fragment.window.document.body.innerHTML));

  const links = collectLinks(fragment.window.document, url);
  const images = collectImages(fragment.window.document);

  const frontmatter = buildFrontmatter(meta, tags, extraFrontmatter);
  const markdown = `${frontmatter}\n${body}`;

  dom.window.close();
  fragment.window.close();

  return { markdown, body, meta, links, images, allLinks };
}

/**
 * The clipper never repeats the page title as a body H1 — it lives in the
 * frontmatter. Drop a leading heading that only restates it.
 */
function dropRedundantTitle(doc, meta) {
  const heading = doc.querySelector('h1');
  if (!heading) return;
  const headingText = normaliseTitle(heading.textContent);
  if (!headingText) return;

  const candidates = [meta.title, meta.h1].filter(Boolean).map(normaliseTitle);
  const matches = candidates.some((candidate) => candidate === headingText
    || candidate.startsWith(`${headingText} `)
    || headingText.startsWith(`${candidate} `));
  if (!matches) return;

  // Only when it really is the top of the document, not a mid-page section.
  const body = doc.body;
  const firstMeaningful = [...body.children].find((el) => (el.textContent || '').trim());
  if (heading === firstMeaningful || firstMeaningful?.contains(heading)) heading.remove();
}

function normaliseTitle(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function collectLinks(doc, baseUrl) {
  const out = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') out.add(url.href);
    } catch { /* skip malformed */ }
  }
  return [...out];
}

function collectImages(doc) {
  const out = new Set();
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:')) out.add(src);
  }
  return [...out];
}

/**
 * Every http(s) link in the full page, not just the article body — the sidebar
 * or index a knowledge-base crawl needs to walk lives outside the content.
 */
export function collectAllLinks(html, url) {
  const dom = parseDocument(html, url);
  const links = collectLinks(dom.window.document, url);
  dom.window.close();
  return links;
}
