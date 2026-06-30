import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogsRequestBody,
  buildLogsUrl,
  logsPath,
  normalizeEvent,
  normalizeTimestamp,
  toRfc2822Date
} from './logs.js';

test('normalizes numeric timestamps from seconds, milliseconds, and nanoseconds', () => {
  assert.equal(normalizeTimestamp(1781892600), '2026-06-19T18:10:00.000Z');
  assert.equal(normalizeTimestamp(1781892600000), '2026-06-19T18:10:00.000Z');
  assert.equal(normalizeTimestamp(1781892600000000000), '2026-06-19T18:10:00.000Z');
});

test('extracts event recipient and reason with fallbacks', () => {
  const event = normalizeEvent(
    {
      '@timestamp': '2026-06-17T14:22:00Z',
      event: 'failed',
      domain: { name: 'acme.com' },
      envelope: { targets: 'user@example.com' },
      'delivery-status': { code: 550, description: 'blocked by provider' }
    }
  );

  assert.equal(event.recipient, 'user@example.com');
  assert.equal(event.reason, 'blocked by provider');
  assert.equal(event.code, 550);
  assert.equal(event.domain, 'acme.com');
});

test('logsPath uses the Logs endpoint', () => {
  assert.equal(logsPath(), '/v1/analytics/logs');
});

test('buildLogsUrl targets analytics logs', () => {
  const url = new URL(buildLogsUrl('https://api.mailgun.net'));
  assert.equal(url.pathname, '/v1/analytics/logs');
});

test('buildLogsRequestBody uses event list, domain filter, and pagination', () => {
  const body = buildLogsRequestBody({
    domain: 'acme.com',
    eventTypes: ['delivered', 'failed'],
    limit: 25,
    sort: 'timestamp:desc',
    duration: '24h'
  });

  assert.deepEqual(body.events, ['delivered', 'failed']);
  assert.equal(body.duration, '24h');
  assert.deepEqual(body.filter.AND, [
    {
      attribute: 'domain',
      comparator: '=',
      values: [{ label: 'acme.com', value: 'acme.com' }]
    }
  ]);
  assert.deepEqual(body.pagination, { sort: 'timestamp:desc', limit: 25 });
});

test('buildLogsRequestBody carries poll window and page token', () => {
  const body = buildLogsRequestBody({
    domain: 'acme.com',
    eventTypes: ['failed'],
    limit: 10,
    sort: 'timestamp:asc',
    start: 'Fri, 19 Jun 2026 18:10:00 GMT',
    end: 'Fri, 19 Jun 2026 18:11:00 GMT',
    token: 'page-2'
  });

  assert.equal(body.start, 'Fri, 19 Jun 2026 18:10:00 GMT');
  assert.equal(body.end, 'Fri, 19 Jun 2026 18:11:00 GMT');
  assert.deepEqual(body.pagination, { sort: 'timestamp:asc', token: 'page-2', limit: 10 });
});

test('toRfc2822Date formats poll cursors for Logs', () => {
  assert.equal(toRfc2822Date(1781892600000), 'Fri, 19 Jun 2026 18:10:00 GMT');
});
