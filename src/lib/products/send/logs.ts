import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';

export interface NormalizedEvent {
  id?: string;
  timestamp: string;
  event: string;
  recipient: string | null;
  reason: string | null;
  code: number | null;
  tags?: string[];
  domain?: string;
}

interface EventsResponse {
  items?: unknown[];
  pagination?: { next?: string };
}

export interface EventsFetchParams {
  apiKey: string;
  baseUrl: string;
  domain: string;
  eventTypes: string[];
  limit: number;
}

export interface LogsRequestBody {
  duration?: string;
  start?: string;
  end?: string;
  events: string[];
  filter: {
    AND: Array<{
      attribute: 'domain';
      comparator: '=';
      values: Array<{ label: string; value: string }>;
    }>;
  };
  pagination: {
    sort: 'timestamp:asc' | 'timestamp:desc';
    token?: string;
    limit: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringAt(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)[segment];
  return typeof current === 'string' && current.length > 0 ? current : null;
}

function numberAt(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)[segment];
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

function stringArrayAt(value: unknown, path: string[]): string[] | null {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)[segment];
  return Array.isArray(current) ? current.filter((item): item is string => typeof item === 'string') : null;
}

export function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return new Date(0).toISOString();
  }

  let milliseconds = value;
  if (value > 1e14) milliseconds = value / 1_000_000;
  else if (value < 1e11) milliseconds = value * 1000;

  return new Date(milliseconds).toISOString();
}

export function extractRecipient(event: unknown): string | null {
  return (
    stringAt(event, ['recipient']) ??
    stringAt(event, ['envelope', 'targets']) ??
    stringAt(event, ['message', 'headers', 'to']) ??
    stringArrayAt(event, ['message', 'recipients'])?.[0] ??
    null
  );
}

export function extractReason(event: unknown): string | null {
  return (
    stringAt(event, ['reason']) ??
    stringAt(event, ['delivery-status', 'message']) ??
    stringAt(event, ['delivery-status', 'description']) ??
    stringAt(event, ['reject', 'description']) ??
    stringAt(event, ['reject', 'reason'])
  );
}

function extractDomain(event: unknown, fallback?: string): string | undefined {
  return stringAt(event, ['domain', 'name']) ?? stringAt(event, ['domain']) ?? fallback;
}

export function normalizeEvent(event: unknown, domain?: string): NormalizedEvent {
  const tags = asRecord(event).tags;
  return {
    id: stringAt(event, ['id']) ?? undefined,
    timestamp: normalizeTimestamp(asRecord(event)['@timestamp'] ?? asRecord(event).timestamp),
    event: stringAt(event, ['event']) ?? 'unknown',
    recipient: extractRecipient(event),
    reason: extractReason(event),
    code: numberAt(event, ['delivery-status', 'code']),
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    domain: extractDomain(event, domain)
  };
}

export function tailDedupeKey(event: NormalizedEvent): string {
  return event.id ?? `${event.timestamp}|${event.event}|${event.recipient ?? ''}|${event.reason ?? ''}`;
}

export function logsPath(): string {
  return '/v1/analytics/logs';
}

export function buildLogsUrl(baseUrl: string): string {
  return buildMailgunUrl(logsPath(), undefined, baseUrl);
}

export function toRfc2822Date(ms: number): string {
  return new Date(ms).toUTCString();
}

export function buildLogsRequestBody(params: {
  domain: string;
  eventTypes: string[];
  limit: number;
  sort: 'timestamp:asc' | 'timestamp:desc';
  duration?: string;
  start?: string;
  end?: string;
  token?: string;
}): LogsRequestBody {
  return {
    ...(params.duration !== undefined ? { duration: params.duration } : {}),
    ...(params.start !== undefined ? { start: params.start } : {}),
    ...(params.end !== undefined ? { end: params.end } : {}),
    events: params.eventTypes,
    filter: {
      AND: [
        {
          attribute: 'domain',
          comparator: '=',
          values: [{ label: params.domain, value: params.domain }]
        }
      ]
    },
    pagination: {
      sort: params.sort,
      ...(params.token !== undefined ? { token: params.token } : {}),
      limit: params.limit
    }
  };
}

async function fetchEventsPage(
  url: string,
  apiKey: string,
  domain: string,
  body: LogsRequestBody
): Promise<{ events: NormalizedEvent[]; next?: string }> {
  const response = await mailgunRequest<EventsResponse>(url, apiKey, 'logs', { method: 'POST', body });
  return {
    events: (response.items ?? []).map((event) => normalizeEvent(event, domain)),
    next: response.pagination?.next
  };
}

function maxEventTimestampMs(events: NormalizedEvent[], current = 0): number {
  let latestMs = current;
  for (const event of events) {
    const ms = Date.parse(event.timestamp);
    if (Number.isFinite(ms)) latestMs = Math.max(latestMs, ms);
  }
  return latestMs;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRecentEvents(params: EventsFetchParams): Promise<NormalizedEvent[]> {
  const url = buildLogsUrl(params.baseUrl);
  const page = await fetchEventsPage(
    url,
    params.apiKey,
    params.domain,
    buildLogsRequestBody({
      domain: params.domain,
      eventTypes: params.eventTypes,
      limit: params.limit,
      sort: 'timestamp:desc',
      duration: '24h'
    })
  );
  return page.events;
}

export async function tailEvents(
  params: EventsFetchParams & { interval: number },
  onEvent: (event: NormalizedEvent) => void
): Promise<void> {
  const url = buildLogsUrl(params.baseUrl);
  const dedupe = new Set<string>();

  const backlog = await fetchEventsPage(
    url,
    params.apiKey,
    params.domain,
    buildLogsRequestBody({
      domain: params.domain,
      eventTypes: params.eventTypes,
      limit: params.limit,
      sort: 'timestamp:desc',
      duration: '24h'
    })
  );
  let latestMs = 0;
  for (const event of [...backlog.events].reverse()) {
    const key = tailDedupeKey(event);
    if (!dedupe.has(key)) {
      dedupe.add(key);
      onEvent(event);
    }
    latestMs = maxEventTimestampMs([event], latestMs);
  }

  let pollStartMs = latestMs > 0 ? latestMs : Date.now();
  while (true) {
    await sleep(params.interval);
    const pollEndMs = Date.now();
    let token: string | undefined;
    do {
      const page = await fetchEventsPage(
        url,
        params.apiKey,
        params.domain,
        buildLogsRequestBody({
          domain: params.domain,
          eventTypes: params.eventTypes,
          limit: params.limit,
          sort: 'timestamp:asc',
          start: toRfc2822Date(pollStartMs),
          end: toRfc2822Date(pollEndMs),
          token
        })
      );
      for (const event of page.events) {
        const key = tailDedupeKey(event);
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        onEvent(event);
        latestMs = maxEventTimestampMs([event], latestMs);
      }
      if (!page.next) break;
      token = page.next;
    } while (true);
    pollStartMs = latestMs > 0 ? latestMs : pollEndMs;
  }
}
