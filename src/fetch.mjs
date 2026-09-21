/**
 * HTTP fetching, robots.txt courtesy, and optional JavaScript rendering.
 *
 * Static fetch is the default because it is fast and most documentation sites
 * (Mintlify, Docusaurus, Nextra, readme.io, GitBook) server-render their prose.
 * `--render` switches to Playwright for the ones that do not.
 */

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

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
    this.robotsCache = new Map();
    this.browser = null;
    this.context = null;
  }

  async getHtml(url) {
    if (this.respectRobots) {
      const allowed = await this.isAllowed(url);
      if (!allowed) {
        const err = new Error('Disallowed by robots.txt');
        err.code = 'ROBOTS';
        throw err;
      }
    }
    return this.render ? this.renderHtml(url) : this.fetchHtml(url);
  }

  async fetchHtml(url, { acceptAnyType = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);
        let response;
        try {
          response = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 429 || response.status >= 500) {
          throw new Error(`HTTP ${response.status}`);
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

        return { html: await response.text(), finalUrl: response.url || url, contentType };
      } catch (error) {
        lastError = error;
        if (error.fatal) break;
        if (attempt < this.retries) await sleep(600 * (attempt + 1));
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
    if (!this.robotsCache.has(origin)) {
      this.robotsCache.set(origin, await this.loadRobots(origin));
    }
    const rules = this.robotsCache.get(origin);
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
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${origin}/robots.txt`, {
        signal: controller.signal,
        headers: { 'User-Agent': this.userAgent },
      });
      clearTimeout(timer);
      if (!response.ok) return [];
      return parseRobots(await response.text());
    } catch {
      return [];
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

/**
 * Minimal robots.txt parser: collects the rules of the `User-agent: *` group.
 * Consecutive User-agent lines form one group, so a `*` anywhere among them
 * means the group's rules apply to us.
 */
export function parseRobots(text) {
  const rules = [];
  let agents = [];
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents) agents = [];   // a new group starts
      agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }

    collectingAgents = false;
    if (!agents.includes('*')) continue;
    if (field === 'disallow') rules.push(value ? { allow: false, path: value } : { allow: true, path: '/' });
    if (field === 'allow' && value) rules.push({ allow: true, path: value });
  }
  return rules;
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
