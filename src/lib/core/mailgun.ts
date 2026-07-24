import fetch from 'node-fetch';
import { CliError } from '../cli/output.js';
import { USER_AGENT } from './version.js';

export type Region = 'us' | 'eu';

export const REGION_HOSTS: Record<Region, string> = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net'
};

// Resolve the API base URL for a region. Subprocess tests can redirect requests
// to a local mock server, but only under NODE_ENV=test; production runtime
// routing remains region-only.
export function regionBaseUrl(region: Region): string {
  if (process.env.NODE_ENV === 'test' && process.env.MAILGUN_TEST_BASE_URL) {
    return process.env.MAILGUN_TEST_BASE_URL;
  }
  return REGION_HOSTS[region];
}

export function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
}

export type QueryValue = string | number | boolean | Array<string | number> | undefined;

export function buildMailgunUrl(
  pathname: string,
  params?: Record<string, QueryValue>,
  baseUrl: string = REGION_HOSTS.us
): string {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function redact(text: string, apiKey: string | null | undefined): string {
  return apiKey ? text.split(apiKey).join('[REDACTED]') : text;
}

export function truncateBody(text: string, maxLength = 500): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

// Per-request timeout so a hung connection fails fast instead of blocking the
// CLI indefinitely (notably the `events --tail` poll loop).
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface MailgunRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}

export async function mailgunRequest<T>(
  url: string,
  apiKey: string,
  operation: string,
  options: MailgunRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(apiKey),
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CliError(`Mailgun ${operation} request timed out after ${timeoutMs}ms`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to fetch Mailgun ${operation}: ${redact(message, apiKey)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError('Mailgun API returned 401 - check your MAILGUN_API_KEY', 1, 401);
    }
    const text = await response.text().catch(() => '');
    const safeBody = truncateBody(redact(text, apiKey));
    if (response.status === 403) {
      const apiResponse = safeBody.length > 0 ? safeBody : 'Forbidden';
      throw new CliError(`Mailgun API returned 403 for ${operation}: ${apiResponse}`, 1, 403);
    }
    throw new CliError(`Mailgun API returned ${response.status}: ${safeBody}`, 1, response.status);
  }

  return (await response.json()) as T;
}
