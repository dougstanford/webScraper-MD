/**
 * Turndown configured to match the Obsidian Web Clipper's output.
 *
 * Base options and the GFM plugin are the clipper's; the extra rules cover the
 * structures docs sites lean on (fenced code with a language, admonitions,
 * highlights, maths) and map them onto Obsidian Flavored Markdown.
 */

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** Inline HTML Obsidian renders natively and the clipper leaves alone. */
const KEEP_TAGS = ['iframe', 'sub', 'sup', 'u', 'ins', 'small', 'kbd', 'abbr', 'video', 'audio'];

export function createTurndown(options = {}) {
  const { wikilinkEmbeds = false } = options;

  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    br: '  ',
    preformattedCode: true,
  });

  td.use(gfm);
  td.keep(KEEP_TAGS);
  td.remove(['script', 'style', 'noscript', 'template']);

  // --- Fenced code with a language ------------------------------------------
  // Turndown's own fenced rule ignores the language unless it sits in a
  // `language-x` class on <code>; docs sites put it in half a dozen places, so
  // preprocess() stashes it on the <pre> and we read it back here.
  td.addRule('fencedCodeBlock', {
    filter: (node) => node.nodeName === 'PRE' && (node.firstChild || node.textContent),
    replacement: (_content, node) => {
      const code = node.querySelector ? node.querySelector('code') : null;
      const text = (code || node).textContent.replace(/\n+$/, '');
      const language = node.getAttribute('data-kbc-lang') || '';
      // Widen the fence if the code itself contains a run of backticks.
      const longest = (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  // --- List items -----------------------------------------------------------
  // Turndown pads bullets to four columns ("-   item"); the clipper emits a
  // single space and indents nested lists by two, which is what the reference
  // clippings contain.
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const text = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      const needsNewline = node.nextSibling && !/\n$/.test(text);
      return prefix + text + (needsNewline ? '\n' : '');
    },
  });

  // --- Obsidian callouts ----------------------------------------------------
  td.addRule('obsidianCallout', {
    filter: (node) => node.nodeType === 1 && node.hasAttribute?.('data-kbc-callout'),
    replacement: (content, node) => {
      const type = node.getAttribute('data-kbc-callout') || 'note';
      let title = node.getAttribute('data-kbc-callout-title') || '';
      // A title that is the bare lowercase type ("[!note] note") is a machine
      // label from the page's own markup; a properly cased one ("Note") is what
      // the page actually showed, so it stays.
      if (title.trim() === type.toLowerCase()) title = '';
      const fold = node.getAttribute('data-kbc-callout-fold') || '';
      const body = content.replace(/^\n+|\n+$/g, '');
      const header = `> [!${type}]${fold}${title ? ` ${title}` : ''}`;
      const quoted = body
        ? body.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')
        : '';
      return `\n\n${header}${quoted ? `\n${quoted}` : ''}\n\n`;
    },
  });

  // --- Strikethrough --------------------------------------------------------
  // turndown-plugin-gfm emits a single tilde; Obsidian and the clipper use two.
  td.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });

  // The callout's own title bar: already rendered into the callout header.
  td.addRule('calloutHeading', {
    filter: (node) => node.nodeType === 1 && node.hasAttribute?.('data-kbc-callout-heading'),
    replacement: () => '',
  });

  // --- Highlights -----------------------------------------------------------
  td.addRule('highlight', {
    filter: (node) => node.nodeName === 'MARK'
      || (node.nodeType === 1 && node.classList?.contains('highlight') && node.nodeName === 'SPAN'),
    replacement: (content) => {
      const text = content.trim();
      return text ? `==${text}==` : content;
    },
  });

  // --- Maths ----------------------------------------------------------------
  td.addRule('math', {
    filter: (node) => node.nodeType === 1 && node.hasAttribute?.('data-kbc-math'),
    replacement: (_content, node) => {
      const tex = node.getAttribute('data-kbc-math');
      return node.hasAttribute('data-kbc-math-display')
        ? `\n\n$$\n${tex}\n$$\n\n`
        : `$${tex}$`;
    },
  });

  // --- Images ---------------------------------------------------------------
  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = (node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      const title = node.getAttribute('title');
      if (wikilinkEmbeds && src.startsWith('attachments/')) {
        return `![[${decodeURIComponent(src.replace(/^attachments\//, ''))}]]`;
      }
      return `![${alt}](${src}${title ? ` "${title}"` : ''})`;
    },
  });

  // --- Figure captions ------------------------------------------------------
  td.addRule('figure', {
    filter: (node) => node.nodeName === 'FIGURE' && node.hasAttribute?.('data-kbc-figure'),
    replacement: (content) => `\n\n${content.replace(/^\n+|\n+$/g, '')}\n\n`,
  });

  // --- Links ----------------------------------------------------------------
  // Drop anchors that carry no text (icon links, tracking pixels) rather than
  // emitting an empty []() pair.
  td.addRule('inlineLink', {
    filter: (node, opts) => opts.linkStyle === 'inlined' && node.nodeName === 'A' && node.getAttribute('href'),
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim();
      const href = node.getAttribute('href') || '';
      if (!text) return '';
      if (!href) return text;
      const title = node.title ? ` "${node.title.replace(/"/g, '\\"')}"` : '';
      return `[${text}](${encodeParens(href)}${title})`;
    },
  });

  return td;
}

function encodeParens(href) {
  return /[()\s]/.test(href) ? `<${href}>`.replace(/^<(\S+)>$/, (m, u) => (/[\s()]/.test(u) ? `<${u}>` : u)) : href;
}

/**
 * Tidy the Turndown output the way the clipper does before it hits the vault:
 * normalise whitespace, collapse blank-line runs, and strip stray artefacts.
 */
export function tidyMarkdown(markdown) {
  return markdown
    .replace(/ /g, ' ')            // non-breaking spaces read as normal spaces
    .replace(/[ \t]+$/gm, (match, offset, str) => {
      // Preserve a deliberate two-space hard line break, drop other trailing space.
      const isHardBreak = match === '  ' && str[offset + match.length] === '\n';
      return isHardBreak ? '  ' : '';
    })
    .replace(/\n{3,}/g, '\n\n')          // no more than one blank line
    .replace(/^(\s*\n)+/, '')            // no leading blank lines
    .replace(/\n+$/, '\n')               // exactly one trailing newline
    .trim() + '\n';
}
