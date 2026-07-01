import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildMailgunUrl, mailgunRequest, redact, regionBaseUrl } from './mailgun.js';

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

test('redact replaces every occurrence of the API key', () => {
  const key = 'key-secret-123';
  const text = `auth failed for ${key}; retried with ${key}`;
  const scrubbed = redact(text, key);
  assert.ok(!scrubbed.includes(key), 'key must not survive redaction');
  assert.equal(scrubbed, 'auth failed for [REDACTED]; retried with [REDACTED]');
});

test('redact leaves text untouched when no key is provided', () => {
  assert.equal(redact('nothing to hide', null), 'nothing to hide');
  assert.equal(redact('nothing to hide', undefined), 'nothing to hide');
});

test('mailgunRequest never leaks the API key in error output', async () => {
  const apiKey = 'key-super-secret-abc';
  // The upstream error body echoes the key back; the CLI must scrub it before
  // it reaches any surface an operator or agent could see.
  const server = http.createServer((_req, res) => {
    res.writeHead(422, { 'Content-Type': 'text/plain' });
    res.end(`rejected credential api:${apiKey}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await assert.rejects(
      mailgunRequest(`http://127.0.0.1:${port}/`, apiKey, 'test'),
      (error: Error) => {
        assert.ok(!error.message.includes(apiKey), 'API key must not appear in the error message');
        assert.ok(error.message.includes('[REDACTED]'), 'redacted marker should be present');
        return true;
      }
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
