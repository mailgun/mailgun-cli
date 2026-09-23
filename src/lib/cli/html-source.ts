import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { UsageError } from './output.js';

const MAX_HTML_BYTES = 5 * 1024 * 1024;

export interface HtmlSource {
  path: string;
  html: string;
  bytes: number;
  sha256: string;
}

// File-only (never stdin or inline); every failure is a usage error raised before any network call.
export function readHtmlSource(pathValue: unknown, limitName: string): HtmlSource {
  if (typeof pathValue !== 'string' || pathValue.trim() === '') {
    throw new UsageError('--html <file> is required and must be a path to an HTML file');
  }
  const path = pathValue.trim();
  let html: string;
  try {
    html = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`could not read --html file '${path}': ${reason}`);
  }
  if (html.trim() === '') {
    throw new UsageError(`--html file '${path}' is empty`);
  }
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    throw new UsageError(
      `--html file '${path}' is ${bytes} UTF-8 bytes, over the ${MAX_HTML_BYTES}-byte (5 MiB) ${limitName} limit`
    );
  }
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  return { path, html, bytes, sha256 };
}
