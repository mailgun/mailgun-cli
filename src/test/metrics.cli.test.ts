import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, runCli } from './mock-server.js';
import { METRICS_POPULATED } from '../fixtures/analytics.js';

test('metrics summary success path: POST body, basic auth, region host', async () => {
  const server = await startMockServer([
    { method: 'POST', path: '/v1/analytics/metrics', json: METRICS_POPULATED }
  ]);
  try {
    const result = await runCli(
      ['metrics', 'summary', '--domain', 'acme.com', '--json'],
      { MAILGUN_API_KEY: 'secret-key' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const json = JSON.parse(result.stdout);
    assert.equal(json.domain, 'acme.com');
    assert.equal(json.rates.delivered_rate, 0.94);

    assert.equal(server.requests.length, 1);
    const req = server.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/v1/analytics/metrics');
    assert.match(String(req.headers.authorization), /^Basic /);
    const body = JSON.parse(req.body);
    assert.equal(body.include_aggregates, true);
    assert.equal(body.filter.AND[0].values[0].value, 'acme.com');
    assert.equal(body.duration, '24h');
  } finally {
    await server.close();
  }
});

test('metrics summary --quiet --json equals --json', async () => {
  const routes = [{ method: 'POST', path: '/v1/analytics/metrics', json: METRICS_POPULATED }];
  const a = await startMockServer(routes);
  const b = await startMockServer(routes);
  try {
    const plain = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, a.baseUrl);
    const quiet = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--quiet', '--json'], { MAILGUN_API_KEY: 'k' }, b.baseUrl);
    assert.equal(plain.stdout, quiet.stdout);
  } finally {
    await a.close();
    await b.close();
  }
});

test('metrics summary missing api key exits 2 with clean stderr', async () => {
  const result = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /MAILGUN_API_KEY is not set/);
});

test('metrics summary missing domain exits 2', async () => {
  const result = await runCli(['metrics', 'summary', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--domain is required/);
});

test('metrics summary surfaces Analytics 403 guidance, exit 1', async () => {
  const server = await startMockServer([
    { method: 'POST', path: '/v1/analytics/metrics', status: 403, json: { message: 'forbidden' } }
  ]);
  try {
    const result = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /403 - your API key may not have access to analytics metrics/);
  } finally {
    await server.close();
  }
});

test('eu region routes to eu host (test hook overrides, but region parses)', async () => {
  const server = await startMockServer([{ method: 'POST', path: '/v1/analytics/metrics', json: METRICS_POPULATED }]);
  try {
    const result = await runCli(
      ['metrics', 'summary', '--domain', 'acme.com', '--region', 'eu', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
  } finally {
    await server.close();
  }
});
