import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildForwardPollUrl,
  buildRecentEventsUrl,
  eventsPath,
  normalizeEvent,
  normalizeTimestamp
} from './events.js';

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

test('eventsPath encodes domain', () => {
  assert.equal(eventsPath('acme.com'), '/v3/acme.com/events');
});

test('buildRecentEventsUrl uses descending order and event OR expression', () => {
  const url = new URL(buildRecentEventsUrl('/v3/acme.com/events', 'delivered OR failed', 25, 'https://api.mailgun.net'));
  assert.equal(url.searchParams.get('event'), 'delivered OR failed');
  assert.equal(url.searchParams.get('ascending'), 'no');
  assert.equal(url.searchParams.get('limit'), '25');
});

test('buildForwardPollUrl uses ascending order and begin cursor', () => {
  const url = new URL(buildForwardPollUrl('/v3/acme.com/events', 'delivered OR failed', 1781892600, 10, 'https://api.mailgun.net'));
  assert.equal(url.searchParams.get('event'), 'delivered OR failed');
  assert.equal(url.searchParams.get('ascending'), 'yes');
  assert.equal(url.searchParams.get('begin'), '1781892600');
  assert.equal(url.searchParams.get('limit'), '10');
});
