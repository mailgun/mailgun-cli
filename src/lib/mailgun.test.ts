import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMailgunUrl } from './mailgun.js';

test('buildMailgunUrl appends repeated query params for arrays', () => {
  const url = buildMailgunUrl('/v3/acme.com/stats/total', {
    event: ['delivered', 'failed', 'complained'],
    duration: '7d'
  });

  const parsed = new URL(url);
  assert.deepEqual(parsed.searchParams.getAll('event'), ['delivered', 'failed', 'complained']);
  assert.equal(parsed.searchParams.get('duration'), '7d');
});
