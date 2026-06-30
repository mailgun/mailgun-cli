import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMailgunUrl, regionBaseUrl } from './mailgun.js';

test('buildMailgunUrl appends repeated query params for arrays', () => {
  const url = buildMailgunUrl('/v3/acme.com/stats/total', {
    event: ['delivered', 'failed', 'complained'],
    duration: '7d'
  });

  const parsed = new URL(url);
  assert.deepEqual(parsed.searchParams.getAll('event'), ['delivered', 'failed', 'complained']);
  assert.equal(parsed.searchParams.get('duration'), '7d');
});

test('regionBaseUrl ignores test override outside NODE_ENV=test', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.MAILGUN_TEST_BASE_URL = 'http://127.0.0.1:9999';
  delete process.env.NODE_ENV;
  try {
    assert.equal(regionBaseUrl('us'), 'https://api.mailgun.net');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    delete process.env.MAILGUN_TEST_BASE_URL;
  }
});

test('regionBaseUrl allows local substitution under NODE_ENV=test', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_TEST_BASE_URL = 'http://127.0.0.1:9999';
  try {
    assert.equal(regionBaseUrl('eu'), 'http://127.0.0.1:9999');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    delete process.env.MAILGUN_TEST_BASE_URL;
  }
});
