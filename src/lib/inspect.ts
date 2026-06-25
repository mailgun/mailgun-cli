import type { DataGap } from './types.js';

// Inspect Email Preview (v2) normalizers. List uses GET /v2/preview/tests; detail
// uses GET /v2/preview/tests/{test_id}, which returns completed/processing/bounced
// client-id arrays plus content_checking availability metadata. No per-client
// detail endpoints, artifacts, or screenshots are fetched in P0.

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function epochToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function headerFrom(headers: unknown): string | null {
  const record = asRecord(headers);
  const value = record.From ?? record.from;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---- list ----

export interface PreviewTestSummary {
  test_id: string | null;
  subject: string | null;
  from: string | null;
  created_at: string | null;
  status: string | null;
}

export interface PreviewListOutput {
  tests: PreviewTestSummary[];
  data_gaps: DataGap[];
}

export function normalizePreviewList(response: unknown): PreviewListOutput {
  const items = Array.isArray(response) ? response : Array.isArray(asRecord(response).items) ? (asRecord(response).items as unknown[]) : [];
  const tests = items.map((item) => {
    const record = asRecord(item);
    return {
      test_id: typeof record.id === 'string' ? record.id : null,
      subject: typeof record.subject === 'string' ? record.subject : null,
      from: headerFrom(record.headers),
      created_at: epochToIso(record.date),
      // The v2 list response does not include a per-test status; it is available
      // only from the test detail endpoint.
      status: null
    } satisfies PreviewTestSummary;
  });
  return { tests, data_gaps: [] };
}

// ---- result detail ----

export type PreviewStatus = 'complete' | 'processing' | 'partial' | 'unknown';

export interface PreviewClient {
  id: string;
  status: 'complete' | 'processing' | 'bounced';
}

export interface ContentCheck {
  available: boolean;
  href: string | null;
}

export interface PreviewResultOutput {
  test_id: string;
  status: PreviewStatus;
  summary: { total_clients: number; complete: number; processing: number; bounced: number };
  clients: PreviewClient[];
  content_checking: {
    link_validation: ContentCheck;
    image_validation: ContentCheck;
    accessibility: ContentCheck;
    code_analysis: ContentCheck;
  };
  data_gaps: DataGap[];
}

// Derive a top-level status mechanically from the client arrays.
export function derivePreviewStatus(complete: number, processing: number, bounced: number): PreviewStatus {
  if (complete + processing + bounced === 0) return 'unknown';
  if (processing > 0) return 'processing';
  if (bounced > 0) return 'partial';
  return 'complete';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function contentCheck(node: unknown): ContentCheck {
  const links = asRecord(asRecord(node).items).links;
  const self = asRecord(links).self;
  const href = typeof self === 'string' && self.length > 0 ? self : null;
  return { available: href !== null, href };
}

export function normalizePreviewResult(testId: string, response: unknown): PreviewResultOutput {
  const record = asRecord(response);
  const completed = stringArray(record.completed);
  const processing = stringArray(record.processing);
  const bounced = stringArray(record.bounced);

  const clients: PreviewClient[] = [
    ...completed.map((id) => ({ id, status: 'complete' as const })),
    ...processing.map((id) => ({ id, status: 'processing' as const })),
    ...bounced.map((id) => ({ id, status: 'bounced' as const }))
  ];

  const status = derivePreviewStatus(completed.length, processing.length, bounced.length);
  const cc = asRecord(record.content_checking);

  const dataGaps: DataGap[] = [];
  if (status === 'unknown') {
    dataGaps.push({
      code: 'preview_clients_unavailable',
      product: 'Inspect',
      message: 'No client rendering state was returned for this test.',
      impact: 'Per-client completion status becomes available once the preview finishes processing.'
    });
  }

  return {
    test_id: typeof record.test_id === 'string' ? record.test_id : testId,
    status,
    summary: {
      total_clients: clients.length,
      complete: completed.length,
      processing: processing.length,
      bounced: bounced.length
    },
    clients,
    content_checking: {
      link_validation: contentCheck(cc.link_validation),
      image_validation: contentCheck(cc.image_validation),
      accessibility: contentCheck(cc.accessibility),
      code_analysis: contentCheck(cc.code_analysis)
    },
    data_gaps: dataGaps
  };
}
