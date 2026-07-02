import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetricsRequestBody, buildMetricsSummary } from './metrics.js';
import { METRICS_POPULATED, METRICS_NO_SEND } from '../../../fixtures/analytics.js';

test('request body includes metrics, aggregates, and domain filter', () => {
  const body = buildMetricsRequestBody({ domain: 'acme.com', duration: '7d' }) as Record<string, any>;
  assert.equal(body.include_aggregates, true);
  assert.deepEqual(body.metrics, [
    'sent_count',
    'delivered_count',
    'permanent_failed_count',
    'temporary_failed_count',
    'hard_bounces_count',
    'complained_count'
  ]);
  assert.equal(body.duration, '7d');
  assert.equal(body.filter.AND[0].attribute, 'domain');
  assert.equal(body.filter.AND[0].comparator, '=');
  assert.deepEqual(body.filter.AND[0].values, [{ label: 'acme.com', value: 'acme.com' }]);
});

test('request body defaults duration to 24h', () => {
  const body = buildMetricsRequestBody({ domain: 'acme.com' }) as Record<string, any>;
  assert.equal(body.duration, '24h');
});

test('request body converts ISO 8601 start/end to RFC 2822 for the Metrics API', () => {
  const body = buildMetricsRequestBody({
    domain: 'acme.com',
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-08T00:00:00Z'
  }) as Record<string, any>;
  assert.equal(body.start, 'Mon, 01 Jun 2026 00:00:00 -0000');
  assert.equal(body.end, 'Mon, 08 Jun 2026 00:00:00 -0000');
  assert.equal(body.duration, undefined);
});

test('summary computes rates from raw counts and normalizes window to ISO', () => {
  const summary = buildMetricsSummary('acme.com', METRICS_POPULATED);
  assert.equal(summary.domain, 'acme.com');
  assert.equal(summary.metrics_raw.sent_count, 1000);
  assert.equal(summary.rates.delivered_rate, 0.94);
  assert.equal(summary.rates.total_fail_rate, 0.05);
  assert.equal(summary.rates.complaint_rate, 0.002);
  assert.deepEqual(summary.data_gaps, []);
  assert.equal(summary.window.start, '2026-06-23T00:00:00.000Z');
});

test('summary flags no_send_in_window and omits rates when sent is zero', () => {
  const summary = buildMetricsSummary('acme.com', METRICS_NO_SEND);
  assert.deepEqual(summary.rates, {});
  assert.equal(summary.data_gaps.length, 1);
  assert.equal(summary.data_gaps[0]!.code, 'no_send_in_window');
  assert.equal(summary.data_gaps[0]!.product, 'Send');
});

test('summary adds metric_unavailable gap and omits dependent rate when a metric is missing', () => {
  const summary = buildMetricsSummary('acme.com', {
    start: 'Mon, 23 Jun 2026 00:00:00 +0000',
    end: 'Tue, 24 Jun 2026 00:00:00 +0000',
    aggregates: { metrics: { sent_count: 100, permanent_failed_count: 1, temporary_failed_count: 1, hard_bounces_count: 0, complained_count: 0 } }
  });
  assert.equal(summary.metrics_raw.delivered_count, undefined);
  assert.equal(summary.rates.delivered_rate, undefined);
  assert.ok(summary.data_gaps.some((g) => g.code === 'metric_unavailable'));
});
