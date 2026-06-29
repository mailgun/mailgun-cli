import fetch from 'node-fetch';
import { CliError } from './output.js';
import { USER_AGENT } from './version.js';

export type Region = 'us' | 'eu';

export const REGION_HOSTS: Record<Region, string> = {
  us: 'https://api.mailgun.net',
  eu: 'https://api.eu.mailgun.net'
};

// Resolve the API base URL for a region. An internal, undocumented test hook
// (MAILGUN_TEST_BASE_URL) redirects requests at a local mock server for
// subprocess API-interception tests. It is not part of the public surface and
// is never advertised in help or agent-context.
export function regionBaseUrl(region: Region): string {
  return process.env.MAILGUN_TEST_BASE_URL ?? REGION_HOSTS[region];
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

export interface MailgunRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

export async function mailgunRequest<T>(
  url: string,
  apiKey: string,
  operation: string,
  options: MailgunRequestOptions = {}
): Promise<T> {
  const { method = 'GET', body } = options;
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
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to fetch Mailgun ${operation}: ${redact(message, apiKey)}`);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new CliError('Mailgun API returned 401 - check your MAILGUN_API_KEY');
    }
    const text = await response.text().catch(() => '');
    const safeBody = truncateBody(redact(text, apiKey));
    if (response.status === 403) {
      const apiResponse = safeBody.length > 0 ? safeBody : 'Forbidden';
      throw new CliError(`Mailgun API returned 403 for ${operation}: ${apiResponse}`);
    }
    throw new CliError(`Mailgun API returned ${response.status}: ${safeBody}`);
  }

  return (await response.json()) as T;
}

// Back-compat GET-only helper retained for the events utility command.
export async function fetchMailgunJSON<T>(url: string, apiKey: string, operation: string): Promise<T> {
  return mailgunRequest<T>(url, apiKey, operation, { method: 'GET' });
}
