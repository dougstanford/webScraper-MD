/**
 * HTTP fetching, robots.txt courtesy, and optional JavaScript rendering.
 *
 * Static fetch is the default because it is fast and most documentation sites
 * (Mintlify, Docusaurus, Nextra, readme.io, GitBook) server-render their prose.
 * `--render` switches to Playwright for the ones that do not.
 */

export const TOOL_NAME = 'webscraper-md';

/** Honest by default: sites can identify, rate-limit, or robots-block us by name. */
const DEFAULT_UA = `${TOOL_NAME}/1.0 (+https://github.com/dougstanford/webScraper-MD)`;

/** Opt-in browser impersonation for sites that serve bots a stub page. */
export const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Largest response body we will read into memory. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/** Longest we will honour a Retry-After header before giving up on the wait. */
const MAX_RETRY_AFTER_MS = 30000;

export class Fetcher {
  constructor({
    userAgent = DEFAULT_UA,
    timeout = 30000,
    render = false,
    respectRobots = true,
    retries = 2,
  } = {}) {
    this.userAgent = userAgent;
    this.timeout = timeout;
    this.render = render;
    this.respectRobots = respectRobots;
    this.retries = retries;
    this.robotsCache = new Map(); // origin -> Promise<rules[]>
    this.browser = null;
    this.context = null;
  }

  async getHtml(url) {
    if (this.respectRobots) await this.assertAllowed(url);
    const result = this.render ? await this.renderHtml(url) : await this.fetchHtml(url);
    // A redirect may have crossed to another origin with its own robots.txt.
    if (this.respectRobots && result.finalUrl && sameOrigin(result.finalUrl, url) === false) {
      await this.assertAllowed(result.finalUrl);
    }
    return result;
  }

  async assertAllowed(url) {
    if (await this.isAllowed(url)) return;
    const err = new Error('Disallowed by robots.txt');
    err.code = 'ROBOTS';
    err.fatal = true;
    throw err;
  }

  async fetchHtml(url, { acceptAnyType = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      // One timer covers headers *and* body: a server that trickles the body
      // forever must not pin a worker.
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        if (response.status === 429 || response.status >= 500) {
          const err = new Error(`HTTP ${response.status}`);
          err.status = response.status;
          err.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          throw err;
        }
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`);
          err.status = response.status;
          err.fatal = true;
          throw err;
        }

        const contentType = response.headers.get('content-type') || '';
        if (!acceptAnyType && contentType
          && !/text\/html|application\/xhtml|text\/plain|text\/markdown/i.test(contentType)) {
          const err = new Error(`Unsupported content-type: ${contentType}`);
          err.fatal = true;
          throw err;
        }

        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_BODY_BYTES) {
          const err = new Error(`Response too large: ${declared} bytes`);
          err.fatal = true;
          throw err;
        }

        const html = await response.text();
        if (html.length > MAX_BODY_BYTES) {
          const err = new Error(`Response too large: ${html.length} bytes`);
          err.fatal = true;
          throw err;
        }

        return { html, finalUrl: response.url || url, contentType };
      } catch (error) {
        lastError = error.name === 'AbortError'
          ? Object.assign(new Error(`Timed out after ${this.timeout}ms`), { code: 'TIMEOUT' })
          : error;
        if (lastError.fatal) break;
        if (attempt < this.retries) {
          await sleep(lastError.retryAfterMs ?? 600 * (attempt + 1));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async renderHtml(url) {
    const page = await this.getPage();
    try {
      // Wait for the document, then give the network a short, bounded chance to
      // settle. A page with a live embed — a video player, a chat widget, an
      // analytics socket — never reaches network idle, and waiting for it to
      // would fail the whole clip.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch {
        // Still talking to the network; the document is rendered regardless.
      }
      // Give client-side routers a beat to paint the article body.
      await page.waitForTimeout(400);
      return { html: await page.content(), finalUrl: page.url(), contentType: 'text/html' };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async getPage() {
    if (!this.browser) {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        throw new Error(
          '--render needs Playwright. Install it with:\n'
          + '  npm install playwright && npx playwright install chromium',
        );
      }
      this.browser = await chromium.launch({ headless: true });
    }
    // One context for the whole run: a context per page would leak, and a
    // leaked context keeps the browser — and the process — alive after the
    // clip has finished.
    if (!this.context) {
      this.context = await this.browser.newContext({ userAgent: this.userAgent });
    }
    return this.context.newPage();
  }

  async isAllowed(url) {
    const { origin, pathname, search } = new URL(url);
    // Cache the promise, not the result, so concurrent workers hitting a new
    // origin share one robots.txt request instead of racing N of them.
    if (!this.robotsCache.has(origin)) {
      this.robotsCache.set(origin, this.loadRobots(origin));
    }
    const rules = await this.robotsCache.get(origin);
    if (!rules || !rules.length) return true;

    const target = pathname + search;
    let verdict = true;
    let bestLength = -1;
    for (const rule of rules) {
      if (!matchesRobotsPath(target, rule.path)) continue;
      // Longest matching directive wins; Allow beats Disallow on a tie.
      if (rule.path.length > bestLength || (rule.path.length === bestLength && rule.allow)) {
        bestLength = rule.path.length;
        verdict = rule.allow;
      }
    }
    return verdict;
  }

  async loadRobots(origin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${origin}/robots.txt`, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent },
      });
      if (!response.ok) return [];
      return parseRobots(await response.text());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return null;
  }
}

/** Retry-After as milliseconds, capped; null when absent or unparseable. */
export function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/**
 * Minimal robots.txt parser: collects the rules of the most specific group
 * that applies to us. A group naming this tool wins over the `*` group, as
 * the spec requires; only one group's rules are used.
 * Consecutive User-agent lines form one group.
 */
export function parseRobots(text) {
  const groups = []; // { agents: string[], rules: [] }
  let current = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }

    collectingAgents = false;
    if (!current) continue;
    if (field === 'disallow') current.rules.push(value ? { allow: false, path: value } : { allow: true, path: '/' });
    if (field === 'allow' && value) current.rules.push({ allow: true, path: value });
  }

  const named = groups.filter((g) => g.agents.some((a) => a === TOOL_NAME || TOOL_NAME.startsWith(a) && a.length > 2));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = named.length ? named : wildcard;
  return chosen.flatMap((g) => g.rules);
}

/** robots.txt path matching, including `*` wildcards and a trailing `$`. */
function matchesRobotsPath(target, pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(target);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
