/**
 * Image downloads for --assets.
 *
 * Everything here is driven by URLs a page chose, so the page is treated as
 * hostile: only http(s), never a private or loopback host, only responses that
 * say they are images, bounded in size and time, and the file's extension
 * comes from the content type rather than whatever the URL claims.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitiseFilename, uniqueName, safeDecode } from './filename.mjs';

/** Largest image we will store. */
const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
};
const IMAGE_EXTENSIONS = new Set(Object.values(EXT_BY_TYPE).concat('.jpeg'));

/** Loopback, link-local, private-range, and local-only hostnames. Literal check; no DNS. */
export function isPrivateHost(hostname) {
  let h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.startsWith('::ffff:')) h = h.slice(7); // IPv4-mapped IPv6
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Download one image into `dir`.
 *
 * Returns `{ name, wrote }`. `wrote` is false on a dry run and when the file
 * already exists and `overwrite` is off. Throws with `err.skip = true` when the
 * URL is not something we should store (wrong scheme, private host, not an
 * image), so callers can report it without counting it as a failure.
 */
export async function downloadAsset(src, {
  dir, taken, userAgent, timeout = 30000, dryRun = false, overwrite = false, allowPrivateHosts = false,
}) {
  const url = new URL(src);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw skip(`unsupported scheme ${url.protocol}`);
  if (!allowPrivateHosts && isPrivateHost(url.hostname)) throw skip(`private host ${url.hostname}`);

  const base = safeDecode(path.basename(url.pathname)) || 'image';
  const urlExt = path.extname(base).toLowerCase();
  const stem = sanitiseFilename(path.basename(base, path.extname(base)) || 'image', { maxLength: 96 });

  if (dryRun) {
    return { name: uniqueName(`${stem}${IMAGE_EXTENSIONS.has(urlExt) ? urlExt : '.png'}`, taken), wrote: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let buffer;
  let contentType;
  try {
    const response = await fetch(src, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': userAgent, Accept: 'image/*' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // The redirect target is as untrusted as the original.
    const landed = new URL(response.url || src);
    if (!allowPrivateHosts && isPrivateHost(landed.hostname)) throw skip(`redirected to private host ${landed.hostname}`);

    contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) throw skip(`not an image (${contentType || 'no content-type'})`);

    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_ASSET_BYTES) throw new Error(`too large: ${declared} bytes`);

    buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ASSET_BYTES) throw new Error(`too large: ${buffer.length} bytes`);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`timed out after ${timeout}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  // Trust the content type for the extension; fall back to a known image
  // extension from the URL; never write whatever the URL happened to end in.
  const ext = EXT_BY_TYPE[contentType] || (IMAGE_EXTENSIONS.has(urlExt) ? urlExt : '.png');
  const name = uniqueName(`${stem}${ext}`, taken);
  const file = path.join(dir, name);

  if (!overwrite && await exists(file)) return { name, wrote: false };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, buffer);
  return { name, wrote: true };
}

function skip(message) {
  const err = new Error(message);
  err.skip = true;
  return err;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
