export type CauseCategory = 'blocklist' | 'invalid_address' | 'content_filter' | 'timeout' | 'unknown';

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

export interface InvestigationSummary {
  total_events: number;
  by_type: {
    failed: number;
    complained: number;
    unsubscribed: number;
  };
  top_failure_reason: string | null;
  cause_category: CauseCategory;
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

export function causeCategory(reason: string | null): CauseCategory {
  const value = reason?.toLowerCase() ?? '';
  if (value.includes('blocked') || value.includes('listed')) return 'blocklist';
  if (value.includes('does not exist') || value.includes('invalid')) return 'invalid_address';
  if (value.includes('spam') || value.includes('content')) return 'content_filter';
  if (value.includes('timeout')) return 'timeout';
  return 'unknown';
}

export function summarizeInvestigation(events: NormalizedEvent[]): InvestigationSummary {
  const byType = { failed: 0, complained: 0, unsubscribed: 0 };
  const reasons = new Map<string, number>();

  for (const event of events) {
    if (event.event === 'failed' || event.event === 'complained' || event.event === 'unsubscribed') {
      byType[event.event] += 1;
    }
    if (event.reason) reasons.set(event.reason, (reasons.get(event.reason) ?? 0) + 1);
  }

  const topFailureReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    total_events: events.length,
    by_type: byType,
    top_failure_reason: topFailureReason,
    cause_category: causeCategory(topFailureReason)
  };
}

export function tailDedupeKey(event: NormalizedEvent): string {
  return event.id ?? `${event.timestamp}|${event.event}|${event.recipient ?? ''}|${event.reason ?? ''}`;
}

export function formatEventTime(timestamp: string, includeDate = false): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const sec = String(date.getUTCSeconds()).padStart(2, '0');
  return includeDate ? `${yyyy}-${mm}-${dd} ${hh}:${min}` : `${hh}:${min}:${sec}`;
}

export function eventSymbol(event: string): string {
  if (event === 'delivered') return '✓';
  if (event === 'failed') return '✗';
  if (event === 'opened') return '↩';
  if (event === 'clicked') return '↪';
  if (event === 'complained') return '!';
  return '-';
}
