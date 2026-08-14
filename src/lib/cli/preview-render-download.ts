import { existsSync, writeFileSync } from 'node:fs';
import { CliError, UsageError } from './output.js';

const MAX_RENDER_BYTES = 25 * 1024 * 1024;
const RENDER_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_RENDER_RETRY_DELAY_MS = 2_000;

function renderRetryDelayMs(retryAfter: string | null, retryCount: number): number {
  const fallback = Math.min(250 * (2 ** retryCount), MAX_RENDER_RETRY_DELAY_MS);
  if (retryAfter === null) return fallback;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1_000, fallback), RENDER_DOWNLOAD_TIMEOUT_MS);
  }
  const retryAt = Date.parse(retryAfter);
  if (!Number.isFinite(retryAt)) return fallback;
  return Math.min(Math.max(retryAt - Date.now(), fallback), RENDER_DOWNLOAD_TIMEOUT_MS);
}

async function waitForRenderRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('render retry aborted');
  await new Promise<void>((resolve, reject) => {
    const retryTimer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(retryTimer);
      reject(new Error('render retry aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function downloadPreviewRender(urlValue: string, outputPath: string): Promise<number> {
  if (existsSync(outputPath)) throw new UsageError(`--output path already exists: ${outputPath}`);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new CliError('Mailgun returned an invalid preview render URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('Mailgun returned an unsupported preview render URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_DOWNLOAD_TIMEOUT_MS);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    let response;
    let retryCount = 0;
    while (true) {
      response = await fetch(url, { signal: controller.signal });
      if (response.status !== 425) break;
      await response.body?.cancel().catch(() => undefined);
      const delayMs = renderRetryDelayMs(response.headers.get('retry-after'), retryCount);
      retryCount += 1;
      await waitForRenderRetry(delayMs, controller.signal);
    }
    if (!response.ok) throw new CliError(`Preview render download returned ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new CliError('Preview render download did not return an image');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RENDER_BYTES) {
      throw new CliError('Preview render image exceeds the 25 MiB download limit');
    }
    if (!response.body) throw new CliError('Preview render download returned an empty body');
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > MAX_RENDER_BYTES) {
        controller.abort();
        throw new CliError('Preview render image exceeds the 25 MiB download limit');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      controller.signal.aborted
        ? `Preview render download timed out after ${RENDER_DOWNLOAD_TIMEOUT_MS}ms`
        : 'Failed to download preview render image'
    );
  } finally {
    clearTimeout(timer);
  }
  writeFileSync(outputPath, Buffer.concat(chunks, totalBytes), { flag: 'wx' });
  return totalBytes;
}
