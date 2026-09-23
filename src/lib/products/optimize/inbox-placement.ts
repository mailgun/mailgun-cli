import type { DataGap } from '../../core/types.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import {
  createOnce,
  failureCause,
  liveDeps,
  pollUntil,
  resolveTimeoutSeconds,
  type PollDeps,
  type RunFailureKind
} from '../../core/write-run.js';

// Optimize Inbox Placement normalizers, verified against the live v4 API:
//   - GET /v4/inbox/results        -> { items: [ <result> ], paging, total }
//   - GET /v4/inbox/results/{id}   -> { result: <result> }
//   - POST /v4/inbox/tests         -> { result_id, mailing_list?, links }
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

// ---- create + poll (`inbox-placement run`) ----

// Each kind is the POST /v4/inbox/tests body key that carries `value`.
export type InboxContentKind = 'html' | 'template_name' | 'account_template_name';

export interface InboxContentSource {
  kind: InboxContentKind;
  value: string;
}

export interface InboxCreateInput {
  from: string;
  subject: string;
  content: InboxContentSource;
  seedList?: string;
  providers?: readonly string[];
  sendingIp?: string;
  sendingIpPoolId?: string;
  maxSeedsPerProvider?: number;
}

export type InboxRunFailureKind = RunFailureKind;

// Structured workflow failure for the command layer to render. Product code
// records what happened; shell-specific recovery wording remains in commands/.
export class InboxRunError extends Error {
  readonly kind: InboxRunFailureKind;
  readonly statusCode?: number;
  readonly resultId?: string;
  readonly detail?: string;

  constructor(params: {
    kind: InboxRunFailureKind;
    statusCode?: number;
    resultId?: string;
    detail?: string;
  }) {
    super(params.kind);
    this.name = 'InboxRunError';
    this.kind = params.kind;
    this.statusCode = params.statusCode;
    this.resultId = params.resultId;
    this.detail = params.detail;
  }
}

export interface InboxPollOutput extends InboxResultOutput {
  timed_out: boolean;
}

export interface InboxRunOutput extends InboxPollOutput {
  mailing_list: string | null;
}

// Body for POST /v4/inbox/tests. Exactly one content source is required by the
// API (html | template_name | account_template_name). Optional provider/seed
// controls are omitted when unset so Mailgun applies its defaults.
export function buildInboxCreateRequest(input: InboxCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    from: input.from,
    subject: input.subject,
    [input.content.kind]: input.content.value
  };

  if (input.seedList) body.seed_list = input.seedList;
  if (input.providers && input.providers.length > 0) body.provider_filter = [...input.providers];
  if (input.sendingIp) body.sending_ip = input.sendingIp;
  if (input.sendingIpPoolId) body.sending_ip_pool_id = input.sendingIpPoolId;
  if (input.maxSeedsPerProvider !== undefined) body.max_seeds_per_provider = input.maxSeedsPerProvider;

  return body;
}

export function extractCreatedResultId(created: unknown): string | null {
  return firstString(asRecord(created).result_id, asRecord(created).id);
}

export function extractCreatedMailingList(created: unknown): string | null {
  return firstString(asRecord(created).mailing_list);
}

const PRODUCT = 'Optimize' as const;
const POLL_INTERVAL_MS = 5000;
const RUN_DEFAULT_TIMEOUT_SECONDS = 300;
const RESULT_DEFAULT_TIMEOUT_SECONDS = 120;
const REQUEST_LABEL = 'inbox placement';

function isTerminalInboxStatus(status: string | null): boolean {
  if (status === null) return false;
  return status.toLowerCase() !== 'processing';
}

export interface InboxPollResult {
  response: unknown;
  timedOut: boolean;
}

// Poll GET /v4/inbox/results/{id} until status leaves "processing" or the
// deadline passes. timeoutMs=0 means fetch once and return.
export async function pollInboxPlacementResult(
  params: { resultId: string; timeoutMs: number; intervalMs?: number; provider?: string },
  deps: PollDeps
): Promise<InboxPollResult> {
  const encodedId = encodeURIComponent(params.resultId);
  const path = params.provider
    ? `/v4/inbox/results/${encodedId}?provider=${encodeURIComponent(params.provider)}`
    : `/v4/inbox/results/${encodedId}`;
  const { state, timedOut } = await pollUntil(
    {
      timeoutMs: params.timeoutMs,
      intervalMs: params.intervalMs ?? POLL_INTERVAL_MS,
      fetch: () => deps.request('GET', path),
      isSettled: (response) => isTerminalInboxStatus(normalizeInboxResult(params.resultId, response).status)
    },
    deps
  );
  return { response: state, timedOut };
}

function buildInboxPollOutput(resultId: string, response: unknown, timedOut: boolean): InboxPollOutput {
  const result = normalizeInboxResult(resultId, response);
  const dataGaps = [...result.data_gaps];
  if (timedOut) {
    dataGaps.push({
      code: 'workflow_timed_out',
      product: PRODUCT,
      message: 'The workflow deadline was reached while the placement test was still processing.',
      impact: 'Placement counts may be incomplete; resume with the same result id.'
    });
  }
  return {
    ...result,
    timed_out: timedOut,
    data_gaps: dataGaps
  };
}

export async function getInboxPlacementResult(params: {
  apiKey: string;
  baseUrl: string;
  resultId: string;
  provider?: string;
  timeoutSeconds?: number;
  deps?: PollDeps;
}): Promise<InboxPollOutput> {
  const deps = params.deps ?? liveDeps(params.apiKey, params.baseUrl, REQUEST_LABEL);
  const timeoutMs = resolveTimeoutSeconds(params.timeoutSeconds, RESULT_DEFAULT_TIMEOUT_SECONDS) * 1000;
  const poll = await pollInboxPlacementResult(
    { resultId: params.resultId, timeoutMs, provider: params.provider },
    deps
  );
  return buildInboxPollOutput(params.resultId, poll.response, poll.timedOut);
}

// Create ONE inbox placement test, then poll and summarize. The create is issued
// once and never retried (the API is not documented as idempotent). Failures
// carry structured recovery context for the command layer.
export async function runInboxPlacementTest(params: {
  apiKey: string;
  baseUrl: string;
  create: InboxCreateInput;
  timeoutSeconds?: number;
  deps?: PollDeps;
  onCreated?: (resultId: string) => void;
}): Promise<InboxRunOutput> {
  const deps = params.deps ?? liveDeps(params.apiKey, params.baseUrl, REQUEST_LABEL);
  const body = buildInboxCreateRequest(params.create);

  const created = await createOnce(
    deps,
    '/v4/inbox/tests',
    body,
    (cause) => new InboxRunError({ kind: 'create_uncertain', ...cause })
  );

  const resultId = extractCreatedResultId(created);
  if (resultId === null) {
    throw new InboxRunError({ kind: 'create_missing_id' });
  }
  const mailingList = extractCreatedMailingList(created);
  params.onCreated?.(resultId);
  const timeoutMs = resolveTimeoutSeconds(params.timeoutSeconds, RUN_DEFAULT_TIMEOUT_SECONDS) * 1000;

  let poll: InboxPollResult;
  try {
    poll = await pollInboxPlacementResult({ resultId, timeoutMs }, deps);
  } catch (error) {
    throw new InboxRunError({ kind: 'poll_failed', resultId, ...failureCause(error) });
  }

  return {
    ...buildInboxPollOutput(resultId, poll.response, poll.timedOut),
    mailing_list: mailingList
  };
}

export { RUN_DEFAULT_TIMEOUT_SECONDS, RESULT_DEFAULT_TIMEOUT_SECONDS };
