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
  paging?: { next?: string };
}

export interface EventsFetchParams {
  apiKey: string;
  baseUrl: string;
  domain: string;
  eventExpr: string;
  limit: number;
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
    stringAt(event, ['message', 'headers', 'to'])
  );
}

export function extractReason(event: unknown): string | null {
  return (
    stringAt(event, ['delivery-status', 'message']) ??
    stringAt(event, ['delivery-status', 'description']) ??
    stringAt(event, ['reject', 'description']) ??
    stringAt(event, ['reject', 'reason'])
  );
}

export function normalizeEvent(event: unknown, domain?: string): NormalizedEvent {
  const tags = asRecord(event).tags;
  return {
    id: stringAt(event, ['id']) ?? undefined,
    timestamp: normalizeTimestamp(asRecord(event).timestamp),
    event: stringAt(event, ['event']) ?? 'unknown',
    recipient: extractRecipient(event),
    reason: extractReason(event),
    code: numberAt(event, ['delivery-status', 'code']),
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    domain
  };
}

export function tailDedupeKey(event: NormalizedEvent): string {
  return event.id ?? `${event.timestamp}|${event.event}|${event.recipient ?? ''}|${event.reason ?? ''}`;
}

export function eventsPath(domain: string): string {
  return `/v3/${encodeURIComponent(domain)}/events`;
}

export function buildRecentEventsUrl(path: string, eventExpr: string, limit: number, baseUrl: string): string {
  return buildMailgunUrl(path, { event: eventExpr, limit, ascending: 'no' }, baseUrl);
}

export function buildForwardPollUrl(
  path: string,
  eventExpr: string,
  beginSec: number,
  limit: number,
  baseUrl: string
): string {
  return buildMailgunUrl(path, { event: eventExpr, ascending: 'yes', begin: beginSec, limit }, baseUrl);
}

async function fetchEventsPage(
  url: string,
  apiKey: string,
  domain: string
): Promise<{ events: NormalizedEvent[]; next?: string }> {
  const response = await mailgunRequest<EventsResponse>(url, apiKey, 'events');
  return {
    events: (response.items ?? []).map((event) => normalizeEvent(event, domain)),
    next: response.paging?.next
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

function beginSecFromMs(latestMs: number): number {
  return latestMs > 0 ? Math.floor(latestMs / 1000) : Math.floor(Date.now() / 1000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRecentEvents(params: EventsFetchParams): Promise<NormalizedEvent[]> {
  const path = eventsPath(params.domain);
  const url = buildRecentEventsUrl(path, params.eventExpr, params.limit, params.baseUrl);
  const page = await fetchEventsPage(url, params.apiKey, params.domain);
  return page.events;
}

export async function tailEvents(
  params: EventsFetchParams & { interval: number },
  onEvent: (event: NormalizedEvent) => void
): Promise<void> {
  const path = eventsPath(params.domain);
  const dedupe = new Set<string>();

  const backlogUrl = buildRecentEventsUrl(path, params.eventExpr, params.limit, params.baseUrl);
  const backlog = await fetchEventsPage(backlogUrl, params.apiKey, params.domain);
  let latestMs = 0;
  for (const event of [...backlog.events].reverse()) {
    const key = tailDedupeKey(event);
    if (!dedupe.has(key)) {
      dedupe.add(key);
      onEvent(event);
    }
    latestMs = maxEventTimestampMs([event], latestMs);
  }

  let beginSec = beginSecFromMs(latestMs);
  while (true) {
    await sleep(params.interval);
    let pollUrl = buildForwardPollUrl(path, params.eventExpr, beginSec, params.limit, params.baseUrl);
    do {
      const page = await fetchEventsPage(pollUrl, params.apiKey, params.domain);
      for (const event of page.events) {
        const key = tailDedupeKey(event);
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        onEvent(event);
        latestMs = maxEventTimestampMs([event], latestMs);
      }
      if (!page.next) break;
      pollUrl = page.next;
    } while (true);
    beginSec = beginSecFromMs(latestMs);
  }
}
