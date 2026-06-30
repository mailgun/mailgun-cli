import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, startMockServer, type RecordedRequest } from './mock-server.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const EVENTS_RESPONSE = {
  items: [
    { id: 'evt-1', timestamp: '2026-06-19T22:10:00Z', event: 'delivered', recipient: 'a@b.com' },
    { id: 'evt-2', timestamp: '2026-06-19T22:10:03Z', event: 'failed', recipient: 'c@d.com', 'delivery-status': { code: 550, message: '550 IP listed' } }
  ],
  paging: {}
};

// ascending=no returns newest-first; mocks should mirror that ordering.
const EVENTS_RESPONSE_DESC = {
  items: [...EVENTS_RESPONSE.items].reverse(),
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
    // Mailgun expects a single OR-joined event filter, not repeated params.
    assert.deepEqual(server.requests[0]!.query.getAll('event'), ['delivered OR failed OR opened OR clicked OR complained']);
    assert.equal(server.requests[0]!.query.get('limit'), '10');
  } finally {
    await server.close();
  }
});

test('events single-fetch forwards --limit and custom --filter to the API', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v3/', json: { items: [EVENTS_RESPONSE.items[0]], paging: {} } }]);
  try {
    const result = await runCli(
      ['events', '--domain', 'acme.com', '--limit', '1', '--filter', 'delivered,failed', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.query.get('limit'), '1');
    assert.deepEqual(server.requests[0]!.query.getAll('event'), ['delivered OR failed']);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    await server.close();
  }
});

test('events --tail shows a backlog (ascending=no) then polls forward (ascending=yes + begin)', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v3/', json: EVENTS_RESPONSE_DESC }]);
  try {
    let stdout = '';
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [cliPath, 'events', '--domain', 'acme.com', '--tail', '--interval', '100', '--json'], {
        env: { ...process.env, CI: '1', NODE_ENV: 'test', MAILGUN_API_KEY: 'k', MAILGUN_TEST_BASE_URL: server.baseUrl }
      });
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      const waitForPolls = setInterval(() => {
        const forwardPolls = server.requests.filter((r) => r.query.get('ascending') === 'yes');
        if (forwardPolls.length >= 2) {
          clearInterval(waitForPolls);
          clearTimeout(safety);
          child.kill('SIGINT');
        }
      }, 25);
      const safety = setTimeout(() => {
        clearInterval(waitForPolls);
        child.kill('SIGINT');
      }, 3000);
      child.on('close', () => resolve());
    });

    const ascendingValues = server.requests.map((r) => r.query.get('ascending'));
    assert.ok(ascendingValues.includes('no'), 'backlog request should use ascending=no');
    const poll = server.requests.find((r) => r.query.get('ascending') === 'yes');
    assert.ok(poll, 'should issue a forward poll with ascending=yes');
    assert.ok(poll!.query.get('begin'), 'forward poll should carry a begin anchor');
    assert.equal(poll!.query.get('limit'), '10', 'forward poll should pass limit');
    assert.equal(server.requests[0]!.query.get('ascending'), 'no');

    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'tail backlog should emit each event once despite repeat polls');
    assert.equal(JSON.parse(lines[0]!).event, 'delivered');
    assert.equal(JSON.parse(lines[1]!).event, 'failed');
  } finally {
    await server.close();
  }
});

test('events --tail resets the forward cursor after paging.next is exhausted', async () => {
  let mockServer: Awaited<ReturnType<typeof startMockServer>>;
  let forwardWithoutPage = 0;
  mockServer = await startMockServer([
    {
      method: 'GET',
      path: '/v3/',
      json: (req: RecordedRequest) => {
        if (req.query.get('ascending') === 'no') {
          return { items: [EVENTS_RESPONSE_DESC.items[0]], paging: {} };
        }
        if (req.query.get('page') === '2') {
          return { items: [], paging: {} };
        }
        forwardWithoutPage += 1;
        if (forwardWithoutPage === 1) {
          return {
            items: [EVENTS_RESPONSE.items[1]],
            paging: { next: `${mockServer.baseUrl}/v3/acme.com/events?ascending=yes&begin=1781926200&page=2` }
          };
        }
        return { items: [], paging: {} };
      }
    }
  ]);
  try {
    let sawReset = false;
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [cliPath, 'events', '--domain', 'acme.com', '--tail', '--interval', '50', '--json'], {
        env: { ...process.env, CI: '1', NODE_ENV: 'test', MAILGUN_API_KEY: 'k', MAILGUN_TEST_BASE_URL: mockServer.baseUrl }
      });
      const waitForReset = setInterval(() => {
        const forward = mockServer.requests.filter((r) => r.query.get('ascending') === 'yes');
        if (
          forward.some((r) => r.query.get('page') === '2') &&
          forward.some((r) => !r.query.get('page')) &&
          forwardWithoutPage >= 2
        ) {
          sawReset = true;
          clearInterval(waitForReset);
          clearTimeout(safety);
          child.kill('SIGINT');
        }
      }, 25);
      const safety = setTimeout(() => {
        clearInterval(waitForReset);
        child.kill('SIGINT');
      }, 3000);
      child.on('close', () => resolve());
    });

    assert.ok(sawReset, 'should start a new forward poll cycle after paging.next is exhausted');
    const forward = mockServer.requests.filter((r) => r.query.get('ascending') === 'yes');
    assert.ok(forward.some((r) => r.query.get('page') === '2'), 'should follow paging.next within a poll cycle');
    const resetPolls = forward.filter((r) => !r.query.get('page'));
    assert.ok(resetPolls.length >= 2, 'second forward cycle should use a fresh begin URL, not a stale page link');
    assert.ok(resetPolls[resetPolls.length - 1]!.query.get('begin'), 'reset poll should carry an updated begin anchor');
  } finally {
    await mockServer.close();
  }
});

test('events rejects --limit over 300 with exit 2', async () => {
  const result = await runCli(['events', '--domain', 'acme.com', '--limit', '301', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--limit must be 300 or less/);
});

test('events rejects decimal --limit with exit 2', async () => {
  const result = await runCli(['events', '--domain', 'acme.com', '--limit', '2.5', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--limit must be a positive integer/);
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

test('events 403 surfaces API response', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v3/', status: 403, json: { message: 'forbidden' } }]);
  try {
    const result = await runCli(['events', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /403 for events/);
    assert.match(result.stderr, /"message":"forbidden"/);
  } finally {
    await server.close();
  }
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
  assert.equal(ctx.commands.events.product, 'Send');
  assert.equal(ctx.commands['metrics summary'].product, 'Send');
  assert.equal(ctx.commands['metrics summary'].mcp_tool, 'get_metrics_summary');
});

test('invalid region exits 2', async () => {
  const result = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--region', 'apac', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid region/);
});
