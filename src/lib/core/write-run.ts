import { performance } from 'node:perf_hooks';
import { buildMailgunUrl, mailgunRequest } from './mailgun.js';

// Shared create-once-then-poll plumbing for write commands.

export type RunFailureKind = 'create_uncertain' | 'create_missing_id' | 'poll_failed';

export type RequestFn = (method: string, path: string, body?: unknown) => Promise<unknown>;

export interface PollDeps {
  request: RequestFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function liveDeps(apiKey: string, baseUrl: string, label: string): PollDeps {
  return {
    request: (method, path, body) =>
      mailgunRequest<unknown>(buildMailgunUrl(path, undefined, baseUrl), apiKey, label, {
        method: method as 'GET' | 'POST',
        ...(body !== undefined ? { body } : {})
      }),
    now: () => performance.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}

export const MAX_TIMEOUT_SECONDS = 600;

export function resolveTimeoutSeconds(value: number | undefined, defaultSeconds: number): number {
  if (value === undefined) return defaultSeconds;
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(`timeout must be an integer between 0 and ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

export interface FailureCause {
  statusCode?: number;
  detail: string;
}

export function failureCause(error: unknown): FailureCause {
  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  return {
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    detail: error instanceof Error ? error.message : String(error)
  };
}

// POST once, never retried: definitive 4xx rethrows, anything else is uncertain.
export async function createOnce(
  deps: PollDeps,
  path: string,
  body: unknown,
  uncertain: (cause: FailureCause) => Error
): Promise<unknown> {
  try {
    return await deps.request('POST', path, body);
  } catch (error) {
    const cause = failureCause(error);
    const status = cause.statusCode;
    if (status !== undefined && status >= 400 && status !== 429 && status < 500) throw error;
    throw uncertain(cause);
  }
}

// Fetch until `isSettled` or the deadline passes. timeoutMs=0 fetches once.
export async function pollUntil<T>(
  params: {
    timeoutMs: number;
    intervalMs: number;
    fetch: () => Promise<T>;
    isSettled: (state: T) => boolean;
  },
  deps: PollDeps
): Promise<{ state: T; timedOut: boolean }> {
  const deadline = deps.now() + params.timeoutMs;
  let state = await params.fetch();
  while (!params.isSettled(state)) {
    if (params.timeoutMs === 0 || deps.now() + params.intervalMs > deadline) {
      return { state, timedOut: true };
    }
    await deps.sleep(params.intervalMs);
    state = await params.fetch();
  }
  return { state, timedOut: false };
}
