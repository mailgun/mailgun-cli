import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetricsInput } from './metrics.js';
import { UsageError } from '../lib/cli/output.js';

test('window aliases to duration', () => {
  assert.deepEqual(validateMetricsInput({ window: '7d' }), { duration: '7d', start: undefined, end: undefined, timezone: undefined });
});

test('window and duration together is a usage error', () => {
  assert.throws(() => validateMetricsInput({ window: '7d', duration: '24h' }), UsageError);
});

test('start without end is a usage error', () => {
  assert.throws(() => validateMetricsInput({ start: '2026-06-01T00:00:00Z' }), UsageError);
});

test('start/end with duration is a usage error', () => {
  assert.throws(
    () => validateMetricsInput({ start: '2026-06-01T00:00:00Z', end: '2026-06-08T00:00:00Z', duration: '24h' }),
    UsageError
  );
});

test('invalid start ISO is a usage error', () => {
  assert.throws(() => validateMetricsInput({ start: 'not-a-date', end: '2026-06-08T00:00:00Z' }), UsageError);
});

test('empty timezone is a usage error', () => {
  assert.throws(() => validateMetricsInput({ duration: '24h', timezone: '' }), UsageError);
});

test('negative duration is a usage error with a helpful message', () => {
  assert.throws(() => validateMetricsInput({ duration: '-7d' }), /must not start with "-"/);
});

test('negative window is a usage error with a helpful message', () => {
  assert.throws(() => validateMetricsInput({ window: '-1m' }), /must not start with "-"/);
});

test('valid start/end pass through', () => {
  assert.deepEqual(validateMetricsInput({ start: '2026-06-01T00:00:00Z', end: '2026-06-08T00:00:00Z' }), {
    duration: undefined,
    start: '2026-06-01T00:00:00Z',
    end: '2026-06-08T00:00:00Z',
    timezone: undefined
  });
});
