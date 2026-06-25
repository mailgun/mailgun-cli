import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, normalizeTimestamp, summarizeInvestigation } from './events.js';

test('normalizes numeric timestamps from seconds, milliseconds, and nanoseconds', () => {
  assert.equal(normalizeTimestamp(1781892600), '2026-06-19T18:10:00.000Z');
  assert.equal(normalizeTimestamp(1781892600000), '2026-06-19T18:10:00.000Z');
  assert.equal(normalizeTimestamp(1781892600000000000), '2026-06-19T18:10:00.000Z');
});

test('extracts event recipient and reason with fallbacks', () => {
  const event = normalizeEvent(
    {
      timestamp: '2026-06-17T14:22:00Z',
      event: 'failed',
      envelope: { targets: 'user@example.com' },
      'delivery-status': { code: 550, description: 'blocked by provider' }
    },
    'acme.com'
  );

  assert.equal(event.recipient, 'user@example.com');
  assert.equal(event.reason, 'blocked by provider');
  assert.equal(event.code, 550);
});

test('summarizes blocklist investigation', () => {
  const events = [
    normalizeEvent({ timestamp: '2026-06-17T14:22:00Z', event: 'failed', recipient: 'a@b.com', 'delivery-status': { message: 'IP listed' } }),
    normalizeEvent({ timestamp: '2026-06-17T14:23:00Z', event: 'complained', recipient: 'c@d.com', 'delivery-status': { message: 'IP listed' } })
  ];
  const summary = summarizeInvestigation(events);

  assert.equal(summary.total_events, 2);
  assert.equal(summary.by_type.failed, 1);
  assert.equal(summary.by_type.complained, 1);
  assert.equal(summary.cause_category, 'blocklist');
});
