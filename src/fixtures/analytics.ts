import type { AnalyticsMetricsResponse } from '../lib/analytics.js';

// Fixtures mirror the raw `POST /v1/analytics/metrics` response shape (aggregates
// only, which is what the summary normalizer reads). Fixed June 2026 timestamps
// keep recordings and snapshot tests reproducible.

// Scenario: a populated 7-day window with sends, fails, bounces, and complaints.
// Counts chosen so the normalizer's computed rates are simple to verify:
// delivered 940/1000 = 0.94, total fail (20+30)/1000 = 0.05.
export const METRICS_POPULATED: AnalyticsMetricsResponse = {
  start: 'Mon, 23 Jun 2026 00:00:00 +0000',
  end: 'Tue, 24 Jun 2026 00:00:00 +0000',
  aggregates: {
    metrics: {
      sent_count: 1000,
      delivered_count: 940,
      permanent_failed_count: 20,
      temporary_failed_count: 30,
      hard_bounces_count: 12,
      complained_count: 2
    }
  }
};

// Scenario: a window with no sending activity. sent_count is present but zero, so
// the normalizer omits all rates and emits a single no_send_in_window data gap.
export const METRICS_NO_SEND: AnalyticsMetricsResponse = {
  start: 'Mon, 23 Jun 2026 00:00:00 +0000',
  end: 'Tue, 24 Jun 2026 00:00:00 +0000',
  aggregates: {
    metrics: {
      sent_count: 0,
      delivered_count: 0,
      permanent_failed_count: 0,
      temporary_failed_count: 0,
      hard_bounces_count: 0,
      complained_count: 0
    }
  }
};
