/**
 * Obsidian-safe note filenames.
 *
 * Matches the clipper's own sanitisation: characters a vault cannot store are
 * deleted rather than substituted, so "A guide | Site 10.2" becomes
 * "A guide  Site 10.2.md" — double space and all.
 */

const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

export function sanitiseFilename(name, { maxLength = 184 } = {}) {
  let out = String(name || 'Untitled')
    .replace(ILLEGAL, '')
    .replace(CONTROL, '')
    .replace(/\n+/g, ' ')
    .replace(/^\.+/, '')        // no leading dots, which would hide the file
    .replace(/\s+$/, '');

  if (!out.trim()) out = 'Untitled';
  if (out.length > maxLength) out = out.slice(0, maxLength).trimEnd();
  return out;
}

/** decodeURIComponent that returns its input on a malformed sequence instead of throwing. */
export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Turn a URL path into a nested output directory, for --tree layout. */
export function pathFromUrl(url, scopePrefix) {
  const u = new URL(url);
  let pathname = u.pathname;
  if (scopePrefix) {
    try {
      const scope = new URL(scopePrefix);
      if (pathname.startsWith(scope.pathname)) pathname = pathname.slice(scope.pathname.length);
    } catch { /* scope is not a URL; ignore */ }
  }
  const segments = pathname.split('/').filter(Boolean);
  segments.pop(); // the leaf becomes the note itself
  return segments.map((segment) => sanitiseFilename(safeDecode(segment)));
}

/** Ensure uniqueness within a run: "Name", "Name 2", "Name 3", ... */
export function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) {
    taken.add(name.toLowerCase());
    return name;
  }
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n += 1;
  const result = `${name} ${n}`;
  taken.add(result.toLowerCase());
  return result;
}
