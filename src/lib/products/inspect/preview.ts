import type { DataGap } from '../../core/types.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';

// Inspect Email Preview (v2) list + client-catalog normalizers. The full
// counts-and-references QA summary (render polling + structured-check counts)
// lives in ./preview-qa.ts so it can stay aligned with the MCP composite.

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

export async function listPreviewTests(params: {
  apiKey: string;
  baseUrl: string;
  limit: number;
  subject?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<PreviewListOutput> {
  const url = buildMailgunUrl(
    '/v2/preview/tests',
    {
      results: params.limit,
      subject: params.subject,
      from: params.fromDate,
      to: params.toDate
    },
    params.baseUrl
  );
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'preview tests');
  return normalizePreviewList(response);
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

// ---- client catalog ----

// GET /v1/preview/tests/clients returns { clients: { <key>: {...} } }. The
// catalog is v1; there is no v2 catalog endpoint. Client IDs are used when a
// caller wants an explicit preview matrix instead of the Mailgun defaults.

export interface PreviewClientCatalogEntry {
  id: string;
  client: string | null;
  os: string | null;
  category: string | null;
  browser: string | null;
  default: boolean;
  free: boolean;
}

export interface PreviewClientsOutput {
  clients: PreviewClientCatalogEntry[];
  data_gaps: DataGap[];
}

export async function listPreviewClients(params: {
  apiKey: string;
  baseUrl: string;
}): Promise<PreviewClientsOutput> {
  const url = buildMailgunUrl('/v1/preview/tests/clients', undefined, params.baseUrl);
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'preview clients');
  return normalizePreviewClients(response);
}

export function normalizePreviewClients(response: unknown): PreviewClientsOutput {
  const catalog = asRecord(asRecord(response).clients);
  const clients = Object.values(catalog)
    .map((value) => asRecord(value))
    .filter((record) => typeof record.id === 'string')
    .map((record) => ({
      id: record.id as string,
      client: typeof record.client === 'string' ? record.client : null,
      os: typeof record.os === 'string' ? record.os : null,
      category: typeof record.category === 'string' ? record.category : null,
      browser: typeof record.browser === 'string' && record.browser.length > 0 ? record.browser : null,
      default: record.default === true,
      free: record.free === true
    }))
    // Stable, deterministic ordering by client id for reproducible output.
    .sort((a, b) => a.id.localeCompare(b.id));

  const dataGaps: DataGap[] = [];
  if (clients.length === 0) {
    dataGaps.push({
      code: 'preview_clients_catalog_empty',
      product: 'Inspect',
      message: 'No preview clients were returned by the catalog.',
      impact: 'Explicit client matrices are unavailable; omit clients to use the Mailgun default set.'
    });
  }

  return { clients, data_gaps: dataGaps };
}
