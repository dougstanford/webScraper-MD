/**
 * DOM normalisation, run before Readability sees the page.
 *
 * The Obsidian Web Clipper works on a live browser DOM, so lazy images have
 * already loaded, relative URLs already resolve, and hidden nodes are already
 * known. Fetching HTML with curl gives us none of that, so we reconstruct it
 * here: absolutise URLs, unwrap lazy-loading and <picture>, drop chrome that
 * Readability would otherwise score as content, and tag the few structures
 * (code language, callouts, maths) our Turndown rules depend on.
 */

const STRIP_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'link', 'meta',
  'nav', 'header > nav', 'footer', 'aside[role="navigation"]',
  '[role="navigation"]', '[role="banner"]', '[role="search"]',
  '[aria-hidden="true"].anchor', '.sr-only', '.visually-hidden', '.screen-reader-text',
  '[data-nosnippet]', '[hidden]',
  // Docs-site chrome that survives Readability more often than it should.
  '.pagination-nav', '.theme-doc-toc-desktop', '.theme-doc-toc-mobile',
  '.table-of-contents', '#table-of-contents', '.toc', '.docs-toc',
  '.breadcrumbs', '[aria-label="Breadcrumb"]', '[aria-label="breadcrumb"]',
  '.edit-this-page', '.rate-this-page', '[class*="feedback" i]',
  '.eyebrow', '.pagination', '.next-prev', '.prev-next',
  // Site shell around the article: navigation columns, backlink and outline
  // panes, graph views. Readability discards these; a container fallback does not.
  '.site-header', '.site-footer', '[class*="sidebar" i]',
  '[class*="left-column" i]', '[class*="right-column" i]',
  '[class*="backlink" i]', '[class*="graph-view" i]', '[class*="outline-view" i]',
  '[class*="on-this-page" i]', '.mod-nav',
  '.cookie-banner', '.cookie-consent', '#onetrust-consent-sdk',
  '.skip-link', '.skip-to-content',
];

/** Anchor-icon links ("¶", "#", link glyphs) that docs generators inject into headings. */
const HEADING_ANCHOR_SELECTORS = [
  'a.anchor', 'a.headerlink', 'a.hash-link', 'a.header-anchor',
  'a[aria-hidden="true"]', 'a.anchor-link',
];

/** Containers whose hidden children are collapsed content, not chrome. */
const COLLAPSIBLE_CONTENT_SELECTOR = '[data-callout], [data-kbc-callout], .callout, .admonition, .theme-admonition, details';

/** Elements a code block must never be lifted out of. */
const CODE_WRAPPER_STOP_SELECTOR = [
  '[data-callout]', '[data-kbc-callout]', '.callout', '.admonition', '.theme-admonition',
  'blockquote', 'li', 'td', 'th', 'details', 'article', 'main', 'form',
].join(', ');

/** Highlighter language ids that Obsidian's own highlighter does not know. */
const LANGUAGE_ALIASES = {
  shellscript: 'bash', shell: 'bash', sh: 'bash', zsh: 'bash', console: 'bash',
  'shell-session': 'bash', jsonc: 'json', json5: 'json',
  plaintext: '', text: '', txt: '', none: '', ansi: '',
};

/** Callout/admonition containers keyed to the Obsidian callout type they map to. */
const CALLOUT_TYPE_WORDS = {
  note: 'note', info: 'info', information: 'info', todo: 'todo',
  abstract: 'abstract', summary: 'summary', tldr: 'tldr',
  tip: 'tip', hint: 'tip', important: 'important', success: 'success',
  check: 'success', done: 'success', question: 'question', faq: 'question',
  help: 'question', warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger', bug: 'bug',
  example: 'example', quote: 'quote', cite: 'quote',
};

const CALLOUT_SELECTORS = [
  '[data-callout]', '.callout', '.admonition', '.theme-admonition',
  '.alert', '.notice', '.rm-Admonition', '.callout-block',
];

/**
 * Some frameworks (Mintlify, parts of MDX tooling) render paragraphs and
 * headings as <span data-as="p">. Restore the real element so block structure
 * survives extraction instead of collapsing into one run-on paragraph.
 */
function restoreSemanticTags(doc) {
  const ALLOWED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'strong', 'em', 'hr', 'div', 'figure', 'figcaption']);

  for (const el of doc.querySelectorAll('[data-as]')) {
    const tag = (el.getAttribute('data-as') || '').toLowerCase();
    if (!ALLOWED.has(tag) || el.tagName.toLowerCase() === tag) continue;
    const replacement = doc.createElement(tag);
    for (const attr of [...el.attributes]) {
      if (attr.name === 'data-as') continue;
      try { replacement.setAttribute(attr.name, attr.value); } catch { /* skip */ }
    }
    while (el.firstChild) replacement.appendChild(el.firstChild);
    el.replaceWith(replacement);
  }
}

/**
 * Docs generators often wrap a whole heading in its permalink anchor
 * (<a href="#x"><h4>Title</h4></a>), which converts to "[#### Title](#x)".
 * Swap the nesting so the heading stays a heading: "#### [Title](#x)".
 */
function unwrapHeadingLinks(doc) {
  for (const anchor of doc.querySelectorAll('a')) {
    const children = [...anchor.children];
    if (children.length !== 1) continue;
    const heading = children[0];
    if (!/^H[1-6]$/.test(heading.tagName)) continue;
    if (anchor.textContent.trim() !== heading.textContent.trim()) continue;

    while (heading.firstChild) anchor.appendChild(heading.firstChild);
    heading.appendChild(anchor.cloneNode(true));
    anchor.replaceWith(heading);
  }
}

function absolutise(doc, baseUrl) {
  const resolve = (value) => {
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return null;
    }
  };

  for (const el of doc.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    const abs = resolve(href);
    if (abs) el.setAttribute('href', abs);
  }

  for (const el of doc.querySelectorAll('img[src], img[data-src], source[src], video[src], audio[src]')) {
    const src = el.getAttribute('src') || el.getAttribute('data-src');
    if (!src || src.startsWith('data:')) continue;
    const abs = resolve(src);
    if (abs) el.setAttribute('src', abs);
  }
}

/** Promote lazy-loading attributes into real src/srcset so images survive extraction. */
function unlazyImages(doc, baseUrl) {
  const LAZY_SRC = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-hi-res-src'];
  const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

  for (const img of doc.querySelectorAll('img')) {
    for (const attr of LAZY_SRC) {
      const value = img.getAttribute(attr);
      if (value && !value.startsWith('data:')) {
        img.setAttribute('src', value);
        break;
      }
    }
    for (const attr of LAZY_SRCSET) {
      const value = img.getAttribute(attr);
      if (value) {
        img.setAttribute('srcset', value);
        break;
      }
    }
    // A 1x1 or base64 placeholder with a srcset behind it: take the largest candidate.
    const src = img.getAttribute('src') || '';
    const srcset = img.getAttribute('srcset');
    if ((!src || src.startsWith('data:')) && srcset) {
      const best = pickFromSrcset(srcset);
      if (best) img.setAttribute('src', best);
    }
    const finalSrc = img.getAttribute('src');
    if (finalSrc && !finalSrc.startsWith('data:')) {
      try {
        img.setAttribute('src', new URL(finalSrc, baseUrl).href);
      } catch { /* leave as-is */ }
    }
  }

  // <picture><source srcset><img></picture> -> the <img>, carrying the best source.
  for (const picture of doc.querySelectorAll('picture')) {
    const img = picture.querySelector('img');
    if (!img) continue;
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) {
      for (const source of picture.querySelectorAll('source[srcset]')) {
        const best = pickFromSrcset(source.getAttribute('srcset'));
        if (best) {
          try {
            img.setAttribute('src', new URL(best, baseUrl).href);
          } catch {
            img.setAttribute('src', best);
          }
          break;
        }
      }
    }
    picture.replaceWith(img);
  }
}

function pickFromSrcset(srcset) {
  if (!srcset) return null;
  const candidates = srcset.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor = ''] = part.split(/\s+/);
      const width = /^(\d+)w$/.exec(descriptor);
      const density = /^([\d.]+)x$/.exec(descriptor);
      const weight = width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1;
      return { url, weight };
    })
    .filter((c) => c.url);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].url;
}

/**
 * True when removing this element would take the article with it.
 *
 * Chrome selectors match on class-name fragments, and a site is free to put
 * "sidebar" or "column" in the class of a wrapper that holds everything. So
 * before removing anything, check that it is not carrying the page.
 */
function carriesTheArticle(el, bodyTextLength) {
  if (el.querySelector('article, main, [role="main"]')) return true;
  if (!bodyTextLength) return false;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
  return text / bodyTextLength > 0.3;
}

function stripChrome(doc) {
  const bodyTextLength = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().length;

  for (const selector of STRIP_SELECTORS) {
    for (const el of doc.querySelectorAll(selector)) {
      if (el.tagName === 'NAV' && el.closest('article')) continue;
      if (carriesTheArticle(el, bodyTextLength)) continue;
      el.remove();
    }
  }

  for (const el of doc.querySelectorAll('[style]')) {
    const style = (el.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    if (!style.includes('display:none') && !style.includes('visibility:hidden')) continue;
    // A collapsed callout or <details> hides content the reader can reveal;
    // that is real content, unlike a hidden menu or dialog.
    if (el.closest(COLLAPSIBLE_CONTENT_SELECTOR)) continue;
    el.remove();
  }

  // Inline <svg> is either an interface icon or a rendered diagram. Turndown
  // has no rule for it, so it would be flattened into a run of label text or
  // kept as a wall of path data; neither belongs in a note. A diagram's own
  // source usually sits in the code block right above it.
  for (const svg of doc.querySelectorAll('svg')) svg.remove();

  // Interface icons and spacers declare their size; they are never content.
  for (const img of doc.querySelectorAll('img[width], img[height]')) {
    const width = Number(img.getAttribute('width'));
    const height = Number(img.getAttribute('height'));
    const tiny = (value) => Number.isFinite(value) && value > 0 && value <= 24;
    if (tiny(width) || tiny(height)) img.remove();
  }

  for (const selector of HEADING_ANCHOR_SELECTORS) {
    for (const a of doc.querySelectorAll(`h1 ${selector}, h2 ${selector}, h3 ${selector}, h4 ${selector}, h5 ${selector}, h6 ${selector}`)) {
      const text = (a.textContent || '').trim();
      if (text.length <= 2) a.remove();
    }
  }

  stripHeadingPermalinks(doc);
}

/** Zero-width characters a permalink glyph hides behind. */
const INVISIBLE = /[​-‍⁠﻿]/g;

/**
 * Remove the permalink affordance docs generators inject into headings.
 *
 * The class-name list above catches the generators that name it ("a.anchor",
 * "a.headerlink"); Mintlify and its kin name it nothing, so match on shape
 * instead — a fragment link inside a heading carrying no visible text is a
 * permalink, never content. Left in place it converts to "[​](#rules)", and
 * because the link sits in a positioning <div>, Turndown breaks the line at
 * the block boundary and the heading loses its own text:
 *
 *     ###
 *     [​](#rules)
 *     Rules
 */
function stripHeadingPermalinks(doc) {
  for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    for (const a of heading.querySelectorAll('a[href^="#"]')) {
      if ((a.textContent || '').replace(INVISIBLE, '').trim().length > 2) continue;
      if (a.querySelector('img')) continue;
      a.remove();
    }

    // The wrapper the permalink sat in is now empty, but it is still a block
    // element, so it would go on splitting the heading across lines. Innermost
    // first, so a wrapper emptied by its child's removal is caught too.
    for (const el of [...heading.querySelectorAll('*')].reverse()) {
      if ((el.textContent || '').replace(INVISIBLE, '').trim()) continue;
      if (el.querySelector('img')) continue;
      el.remove();
    }
  }
}

/**
 * Record the language of every code block on the element itself, so the
 * Turndown rule does not have to re-derive it from class soup.
 */
function tagCodeLanguages(doc) {
  const fromClassList = (el) => {
    for (const cls of el.classList || []) {
      const m = /^(?:language|lang|highlight-source|brush:|syntax)[-:]?([a-z0-9+#.-]+)$/i.exec(cls);
      if (m && m[1] && m[1] !== 'none') return m[1].toLowerCase();
    }
    return null;
  };

  for (const pre of doc.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const candidates = [code, pre, pre.parentElement].filter(Boolean);
    let language = null;
    for (const el of candidates) {
      language = language
        || fromClassList(el)
        || el.getAttribute?.('data-language')
        || el.getAttribute?.('data-lang')
        || el.getAttribute?.('data-code-language')
        || el.getAttribute?.('language');
      if (language) break;
    }
    if (language) {
      const normalised = LANGUAGE_ALIASES[String(language).toLowerCase()]
        ?? String(language).toLowerCase();
      if (normalised) pre.setAttribute('data-kbc-lang', normalised);
    }

    // Syntax highlighters split code across spans; flatten to text so Turndown
    // does not emit markup inside the fence.
    if (code && code.querySelector('span, div, br')) {
      for (const br of code.querySelectorAll('br')) br.replaceWith(doc.createTextNode('\n'));
      const lineWrappers = code.querySelectorAll('.line, .code-line, [data-line-number]');
      if (lineWrappers.length > 1) {
        const lines = [...lineWrappers].map((line) => line.textContent.replace(/\n+$/, ''));
        code.textContent = lines.join('\n');
      } else {
        code.textContent = code.textContent;
      }
    }
  }
}

/**
 * Lift <pre> blocks out of their decorative wrappers.
 *
 * Docs generators bury code in a chrome div (copy button, line numbers, fade
 * overlay). Readability scores those wrappers as boilerplate and removes them,
 * taking the code with it, so we drop the wrapper and keep the <pre>.
 */
function unwrapCodeBlocks(doc) {
  for (const pre of doc.querySelectorAll('pre')) {
    // Chrome first: it is what makes the wrapper look like boilerplate.
    const preText = (pre.textContent || '').trim();
    let wrapper = pre.parentElement;
    while (wrapper && wrapper !== doc.body) {
      // Only ever lift out of a purely decorative wrapper: never out of a
      // callout, quote, list item or table cell, which carry meaning.
      if (!/^(DIV|SECTION|FIGURE|SPAN)$/.test(wrapper.tagName)) break;
      if (wrapper.matches(CODE_WRAPPER_STOP_SELECTOR)) break;
      // Stop as soon as the wrapper carries prose of its own.
      if ((wrapper.textContent || '').trim().length > preText.length + 40) break;
      wrapper = wrapper.parentElement;
    }

    const target = pre.parentElement === wrapper ? null : pre.parentElement;
    if (!target) continue;

    let outermost = pre.parentElement;
    while (outermost.parentElement && outermost.parentElement !== wrapper) {
      outermost = outermost.parentElement;
    }
    for (const chrome of outermost.querySelectorAll('button, [role="button"], [data-floating-buttons], [aria-hidden="true"]')) {
      if (!chrome.contains(pre)) chrome.remove();
    }

    // Many generators label a block with its filename above the code. Keep that
    // label as its own line rather than losing it with the wrapper.
    const wrapperText = (outermost.textContent || '').trim();
    const label = wrapperText.startsWith(preText)
      ? wrapperText.slice(preText.length).trim()
      : wrapperText.replace(preText, '').trim();

    if (label && label.length <= 120 && !label.includes('\n')) {
      const caption = doc.createElement('p');
      caption.textContent = label;
      outermost.replaceWith(caption);
      caption.after(pre);
    } else {
      outermost.replaceWith(pre);
    }
  }
}

/** Normalise admonition/callout blocks into a shape the Turndown rule can read. */
function tagCallouts(doc) {
  const titleSelector = [
    '.callout-title', '.admonition-title', '.admonitionHeading',
    '.alert-title', '.rm-Admonition-title', '.theme-admonition-heading',
    'header', '.title', '[class*="Heading"]',
  ].join(', ');

  for (const selector of CALLOUT_SELECTORS) {
    for (const el of doc.querySelectorAll(selector)) {
      if (el.hasAttribute('data-kbc-callout')) continue;

      // An explicitly declared type is the author's own word for it — Obsidian
      // accepts aliases like [!faq], so keep it rather than normalising.
      let type = el.getAttribute('data-callout') || el.getAttribute('data-type') || null;
      let declared = Boolean(type);

      if (!type) {
        const haystack = [...(el.classList || [])].join(' ').toLowerCase();
        for (const word of Object.keys(CALLOUT_TYPE_WORDS)) {
          if (new RegExp(`(^|[-_ ])${word}([-_ ]|$)`).test(haystack)) { type = word; break; }
        }
      }

      const titleEl = el.querySelector(titleSelector);
      const titleText = titleEl ? titleEl.textContent.trim() : '';

      if (!type && titleText) {
        const firstWord = titleText.toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g, '');
        if (CALLOUT_TYPE_WORDS[firstWord]) type = firstWord;
      }
      if (!type) continue;

      const lower = type.toLowerCase();
      el.setAttribute('data-kbc-callout', declared ? lower : (CALLOUT_TYPE_WORDS[lower] || lower));
      if (titleText) {
        el.setAttribute('data-kbc-callout-title', titleText);
        // Mark the title node rather than removing it: a callout that is
        // nothing but a title would otherwise be left empty, and Turndown
        // skips empty nodes before any rule of ours can run.
        if (titleEl && titleEl.textContent.trim() === titleText) {
          titleEl.setAttribute('data-kbc-callout-heading', '');
        }
      }
      const fold = (el.getAttribute('data-callout-fold') || '').trim();
      if (fold === '-' || fold === '+') {
        el.setAttribute('data-kbc-callout-fold', fold);
      } else if (el.classList.contains('is-collapsed')) {
        el.setAttribute('data-kbc-callout-fold', '-');
      }
    }
  }

  calloutsToBlockquotes(doc);
}

/**
 * Re-house each tagged callout in a <blockquote>.
 *
 * It is what a callout is in Markdown, and it also protects the block from
 * Readability, whose conditional cleaning targets <div> and would otherwise
 * discard short callouts as boilerplate.
 */
function calloutsToBlockquotes(doc) {
  const callouts = [...doc.querySelectorAll('[data-kbc-callout]')].reverse();
  for (const el of callouts) {
    if (el.tagName === 'BLOCKQUOTE') continue;
    const quote = doc.createElement('blockquote');
    for (const attr of ['data-kbc-callout', 'data-kbc-callout-title', 'data-kbc-callout-fold']) {
      if (el.hasAttribute(attr)) quote.setAttribute(attr, el.getAttribute(attr));
    }
    while (el.firstChild) quote.appendChild(el.firstChild);
    el.replaceWith(quote);
  }
}

/**
 * Replace rendered maths (KaTeX / MathJax) with a single placeholder element
 * carrying the TeX source, so we emit $...$ instead of a wall of spans.
 */
function tagMath(doc) {
  const makePlaceholder = (tex, display) => {
    const span = doc.createElement('span');
    span.setAttribute('data-kbc-math', tex);
    if (display) span.setAttribute('data-kbc-math-display', 'true');
    return span;
  };

  for (const el of doc.querySelectorAll('.katex, .katex-display, mjx-container, .MathJax, .math')) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    const scriptTex = el.querySelector('script[type^="math/tex"]');
    const tex = (annotation?.textContent || scriptTex?.textContent || el.getAttribute('data-tex') || '').trim();
    if (!tex) continue;
    const display = el.classList.contains('katex-display')
      || el.getAttribute('display') === 'block'
      || /mode=display/.test(scriptTex?.getAttribute('type') || '');
    el.replaceWith(makePlaceholder(tex, display));
  }
}

/**
 * Rewrite the embeds Obsidian can render from a bare URL — YouTube, Vimeo,
 * X/Twitter — into a placeholder the image rule turns into `![](url)`.
 * Any other iframe is left alone and kept as HTML.
 */
const EMBED_PATTERNS = [
  [/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/i, (id) => `https://www.youtube.com/watch?v=${id}`],
  [/player\.vimeo\.com\/video\/(\d+)/i, (id) => `https://vimeo.com/${id}`],
  [/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i, (id) => `https://x.com/i/status/${id}`],
  // platform.twitter.com/embed/Tweet.html?...&id=<tweet id>
  [/platform\.(?:twitter|x)\.com\/embed\/[^?]*\?[^"]*\bid=(\d+)/i, (id) => `https://x.com/i/status/${id}`],
];

function tagEmbeds(doc) {
  for (const frame of doc.querySelectorAll('iframe[src], blockquote.twitter-tweet')) {
    const src = frame.getAttribute('src')
      || frame.querySelector('a[href*="status"]')?.getAttribute('href')
      || '';
    if (!src) continue;

    for (const [pattern, toUrl] of EMBED_PATTERNS) {
      const match = pattern.exec(src);
      if (!match) continue;
      const img = doc.createElement('img');
      img.setAttribute('src', toUrl(match[1]));
      img.setAttribute('alt', '');
      frame.replaceWith(img);
      break;
    }
  }
}

/** Fold <figure>/<figcaption> into an image plus caption Turndown can render. */
function tagFigures(doc) {
  for (const figure of doc.querySelectorAll('figure')) {
    const caption = figure.querySelector('figcaption');
    if (!caption) continue;
    const img = figure.querySelector('img');
    const text = caption.textContent.trim();
    if (img && text && !img.getAttribute('alt')) img.setAttribute('alt', text);
    figure.setAttribute('data-kbc-figure', text);
  }
}

/**
 * Prepare a document for extraction. Mutates and returns `doc`.
 */
export function preprocess(doc, baseUrl) {
  restoreSemanticTags(doc);
  unwrapHeadingLinks(doc);
  absolutise(doc, baseUrl);
  unlazyImages(doc, baseUrl);
  stripChrome(doc);
  tagCodeLanguages(doc);
  unwrapCodeBlocks(doc);
  tagCallouts(doc);
  tagMath(doc);
  tagEmbeds(doc);
  tagFigures(doc);
  return doc;
}

export { CALLOUT_TYPE_WORDS };
