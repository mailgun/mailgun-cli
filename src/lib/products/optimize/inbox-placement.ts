import type { DataGap } from '../../core/types.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';

// Optimize Inbox Placement normalizers, verified against the live v4 API:
//   - GET /v4/inbox/results        -> { items: [ <result> ], paging, total }
//   - GET /v4/inbox/results/{id}   -> { result: <result> }
// A <result> uses underscored fields (result_id, subject, sender, created_at,
// status), an `spamassassin` object, and `delivery_stats` as a provider-keyed
// MAP whose `all` entry is the aggregate. (The OpenAPI examples were empty /
// placeholder, so these shapes come from live smoke.)

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// Normalize a date that may be an ISO string or epoch seconds/ms. The upstream
// zero value "0001-01-01T00:00:00Z" is treated as absent.
function normalizeDate(value: unknown): string | null {
  if (typeof value === 'string') {
    if (value.startsWith('0001-01-01')) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// inbox_rate = inbox / (inbox + spam + missing + pending). Null when no seeds.
function inboxRate(inbox: number, spam: number, missing: number, pending: number): number | null {
  const denom = inbox + spam + missing + pending;
  return denom > 0 ? round3(inbox / denom) : null;
}

// ---- list ----

export interface InboxResultSummary {
  result_id: string | null;
  subject: string | null;
  sender: string | null;
  created_at: string | null;
  status: string | null;
}

export interface InboxListOutput {
  results: InboxResultSummary[];
  data_gaps: DataGap[];
}

export async function listInboxPlacementResults(params: {
  apiKey: string;
  baseUrl: string;
  limit: number;
  subject?: string;
  sender?: string;
  provider?: string;
}): Promise<InboxListOutput> {
  const url = buildMailgunUrl(
    '/v4/inbox/results',
    {
      limit: params.limit,
      subject: params.subject,
      sender: params.sender,
      provider: params.provider
    },
    params.baseUrl
  );
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'inbox placement results');
  return normalizeInboxList(response);
}

function summarizeListItem(item: unknown): InboxResultSummary {
  const record = asRecord(item);
  return {
    result_id: firstString(record.result_id, record.rid, record.id),
    subject: firstString(record.subject),
    sender: firstString(record.sender),
    created_at: normalizeDate(record.created_at),
    status: firstString(record.status)
  };
}

export function normalizeInboxList(response: unknown): InboxListOutput {
  const record = asRecord(response);
  const items = Array.isArray(record.items) ? record.items : [];
  return { results: items.map(summarizeListItem), data_gaps: [] };
}

// ---- result detail ----

export interface ProviderPlacement {
  provider: string | null;
  inbox: number;
  spam: number;
  missing: number;
  pending: number;
  inbox_rate: number | null;
}

export interface Placement {
  inbox: number;
  spam: number;
  missing: number;
  pending: number;
  inbox_rate: number | null;
}

export interface SpamAssassinSummary {
  is_spam: boolean | null;
  score: number | null;
  required: number | null;
}

export interface InboxResultOutput {
  result_id: string;
  status: string | null;
  subject: string | null;
  sender: string | null;
  placement: Placement;
  providers: ProviderPlacement[];
  spamassassin: SpamAssassinSummary | null;
  data_gaps: DataGap[];
}

export async function getInboxPlacementResult(params: {
  apiKey: string;
  baseUrl: string;
  resultId: string;
  provider?: string;
}): Promise<InboxResultOutput> {
  const url = buildMailgunUrl(
    `/v4/inbox/results/${encodeURIComponent(params.resultId)}`,
    { provider: params.provider },
    params.baseUrl
  );
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'inbox placement result');
  return normalizeInboxResult(params.resultId, response);
}

function counts(stats: Record<string, unknown>): { inbox: number; spam: number; missing: number; pending: number } {
  return {
    inbox: firstNumber(stats.inbox) ?? 0,
    spam: firstNumber(stats.spam) ?? 0,
    missing: firstNumber(stats.missing) ?? 0,
    pending: firstNumber(stats.pending) ?? 0
  };
}

function normalizeProvider(stats: unknown, fallbackName: string): ProviderPlacement {
  const record = asRecord(stats);
  const c = counts(record);
  return {
    provider: firstString(record.provider) ?? fallbackName,
    ...c,
    inbox_rate: inboxRate(c.inbox, c.spam, c.missing, c.pending)
  };
}

function normalizeSpamAssassin(value: unknown): SpamAssassinSummary | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    is_spam: typeof record.is_spam === 'boolean' ? record.is_spam : typeof record.isspam === 'boolean' ? record.isspam : null,
    score: firstNumber(record.score),
    required: firstNumber(record.required)
  };
}

export function normalizeInboxResult(resultId: string, response: unknown): InboxResultOutput {
  // The detail endpoint wraps the result in a top-level `result` envelope; the
  // list endpoint returns the same object bare. Tolerate both.
  const outer = asRecord(response);
  const record = outer.result !== undefined ? asRecord(outer.result) : outer;

  // delivery_stats is a provider-keyed map; `all` is the aggregate.
  const deliveryStats = asRecord(record.delivery_stats);
  const providers = Object.entries(deliveryStats)
    .filter(([key]) => key !== 'all')
    .map(([key, value]) => normalizeProvider(value, key));

  // Aggregate placement: prefer the upstream `all` entry; otherwise sum providers.
  const allStats = counts(asRecord(deliveryStats.all));
  const hasAll = allStats.inbox + allStats.spam + allStats.missing + allStats.pending > 0;
  const placementCounts = hasAll
    ? allStats
    : providers.reduce(
        (acc, p) => ({
          inbox: acc.inbox + p.inbox,
          spam: acc.spam + p.spam,
          missing: acc.missing + p.missing,
          pending: acc.pending + p.pending
        }),
        { inbox: 0, spam: 0, missing: 0, pending: 0 }
      );

  const placement: Placement = {
    ...placementCounts,
    inbox_rate: inboxRate(placementCounts.inbox, placementCounts.spam, placementCounts.missing, placementCounts.pending)
  };

  const dataGaps: DataGap[] = [];
  if (providers.length === 0 && placement.inbox_rate === null) {
    dataGaps.push({
      code: 'placement_pending',
      product: 'Optimize',
      message: 'No provider placement data is available yet for this result.',
      impact: 'Provider-level inbox/spam breakdown becomes available once processing completes.'
    });
  }

  return {
    result_id: firstString(record.result_id, record.rid, record.id) ?? resultId,
    status: firstString(record.status),
    subject: firstString(record.subject),
    sender: firstString(record.sender),
    placement,
    providers,
    spamassassin: normalizeSpamAssassin(record.spamassassin),
    data_gaps: dataGaps
  };
}
