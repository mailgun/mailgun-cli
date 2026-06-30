import type { DataGap } from '../../core/types.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';

// Normalize an upstream window bound to an ISO 8601 string. The Send metrics
// endpoint returns RFC1123-style dates (e.g. "Wed, 24 Jun 2026 00:00:00 +0000");
// the CLI presents ISO for consistency. Unparseable or missing values become null.
function normalizeWindowBound(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

// CLI equivalent of the MCP `get_metrics_summary` primitive. Request body and
// metric set are aligned with ../mailgun-mcp-server custom tool; output follows
// the CLI's structured data_gaps convention rather than the MCP string array.

export const REQUIRED_METRICS = [
  'sent_count',
  'delivered_count',
  'permanent_failed_count',
  'temporary_failed_count',
  'hard_bounces_count',
  'complained_count'
] as const;

export const DEFAULT_DURATION = '24h';

export interface MetricsRequestParams {
  domain: string;
  start?: string;
  end?: string;
  duration?: string;
  timezone?: string;
}

export interface MetricsSummary {
  domain: string;
  metrics_raw: Record<string, number>;
  rates: Record<string, number>;
  data_gaps: DataGap[];
  window: { start: string | null; end: string | null };
}

export interface SendMetricsResponse {
  start?: string;
  end?: string;
  aggregates?: {
    metrics?: Record<string, unknown>;
  };
}

export async function getMetricsSummary(params: MetricsRequestParams & { apiKey: string; baseUrl: string }): Promise<MetricsSummary> {
  const url = buildMailgunUrl('/v1/analytics/metrics', undefined, params.baseUrl);
  const body = buildMetricsRequestBody(params);
  const response = await mailgunRequest<SendMetricsResponse>(url, params.apiKey, 'metrics', {
    method: 'POST',
    body
  });
  return buildMetricsSummary(params.domain, response);
}

export function buildMetricsRequestBody(params: MetricsRequestParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    metrics: [...REQUIRED_METRICS],
    include_aggregates: true,
    filter: {
      AND: [
        {
          attribute: 'domain',
          comparator: '=',
          values: [{ label: params.domain, value: params.domain }]
        }
      ]
    }
  };

  if (params.start && params.end) {
    body.start = params.start;
    body.end = params.end;
  } else if (params.duration) {
    body.duration = params.duration;
  } else {
    body.duration = DEFAULT_DURATION;
  }

  if (params.timezone) {
    body.timezone = params.timezone;
  }

  return body;
}

function getCount(metrics: Record<string, unknown>, key: string): number | undefined {
  const value = metrics[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function metricGap(key: string): DataGap {
  return {
    code: 'metric_unavailable',
    product: 'Send',
    message: `Metric ${key} was not returned for this window.`,
    impact: 'Rates that depend on this metric were omitted.'
  };
}

const NO_SEND_GAP: DataGap = {
  code: 'no_send_in_window',
  product: 'Send',
  message: 'No messages were sent in this window.',
  impact: 'Rates cannot be computed without a positive sent count.'
};

export function buildMetricsSummary(domain: string, data: SendMetricsResponse): MetricsSummary {
  const aggregates = data.aggregates?.metrics ?? {};
  const dataGaps: DataGap[] = [];
  const metricsRaw: Record<string, number> = {};
  const rates: Record<string, number> = {};

  for (const key of REQUIRED_METRICS) {
    const value = getCount(aggregates, key);
    if (value === undefined) {
      dataGaps.push(metricGap(key));
    } else {
      metricsRaw[key] = value;
    }
  }

  const sentCount = metricsRaw.sent_count;
  if (sentCount === undefined || sentCount <= 0) {
    // Only flag a no-send window when the count was actually returned as <= 0;
    // a missing sent_count already produced a metric_unavailable gap.
    if (sentCount !== undefined) dataGaps.push(NO_SEND_GAP);
  } else {
    if (metricsRaw.delivered_count !== undefined) rates.delivered_rate = metricsRaw.delivered_count / sentCount;
    if (metricsRaw.permanent_failed_count !== undefined) rates.permanent_fail_rate = metricsRaw.permanent_failed_count / sentCount;
    if (metricsRaw.temporary_failed_count !== undefined) rates.temporary_fail_rate = metricsRaw.temporary_failed_count / sentCount;
    if (metricsRaw.hard_bounces_count !== undefined) rates.hard_bounce_rate = metricsRaw.hard_bounces_count / sentCount;
    if (metricsRaw.complained_count !== undefined) rates.complaint_rate = metricsRaw.complained_count / sentCount;
    if (metricsRaw.permanent_failed_count !== undefined && metricsRaw.temporary_failed_count !== undefined) {
      rates.total_fail_rate = (metricsRaw.permanent_failed_count + metricsRaw.temporary_failed_count) / sentCount;
    }
  }

  return {
    domain,
    metrics_raw: metricsRaw,
    rates,
    data_gaps: dataGaps,
    window: { start: normalizeWindowBound(data.start), end: normalizeWindowBound(data.end) }
  };
}
