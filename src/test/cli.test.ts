import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, startMockServer } from './mock-server.js';

const EVENTS_RESPONSE = {
  items: [
    { id: 'evt-1', timestamp: '2026-06-19T22:10:00Z', event: 'delivered', recipient: 'a@b.com' },
    { id: 'evt-2', timestamp: '2026-06-19T22:10:03Z', event: 'failed', recipient: 'c@d.com', 'delivery-status': { code: 550, message: '550 IP listed' } }
  ],
  paging: {}
};

test('events single-fetch emits NDJSON via the real (mocked) API path', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v3/', json: EVENTS_RESPONSE }]);
  try {
    const result = await runCli(['events', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).domain, 'acme.com');
    assert.equal(server.requests[0]!.path, '/v3/acme.com/events');
    assert.match(String(server.requests[0]!.headers.authorization), /^Basic /);
  } finally {
    await server.close();
  }
});

test('events missing api key exits 2 (usage taxonomy)', async () => {
  const result = await runCli(['events', '--domain', 'acme.com', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /MAILGUN_API_KEY is not set/);
});

test('events missing domain exits 2', async () => {
  const result = await runCli(['events', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--domain is required/);
});

test('events invalid --filter exits 2', async () => {
  const result = await runCli(['events', '--domain', 'acme.com', '--filter', 'bogus', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--filter must contain only/);
});

test('agent-context lists all production commands and excludes retired health/investigate', async () => {
  const result = await runCli(['agent-context']);
  assert.equal(result.code, 0);
  const ctx = JSON.parse(result.stdout);
  const keys = Object.keys(ctx.commands);
  assert.deepEqual(
    keys,
    ['agent-context', 'events', 'inbox-placement list', 'inbox-placement result', 'metrics summary', 'preview list', 'preview result', 'validate-email']
  );
  assert.ok(!keys.includes('health'));
  assert.ok(!keys.includes('investigate'));
  assert.equal(ctx.commands['metrics summary'].mcp_tool, 'get_metrics_summary');
});

test('invalid region exits 2', async () => {
  const result = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--region', 'apac', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid region/);
});
