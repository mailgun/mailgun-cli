import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, startMockServer, type RecordedRequest } from './mock-server.js';

const cliPath = fileURLToPath(new URL('../index.js', import.meta.url));

const EVENTS_RESPONSE = {
  items: [
    { id: 'evt-1', '@timestamp': '2026-06-19T22:10:00Z', event: 'delivered', domain: { name: 'acme.com' }, recipient: 'a@b.com' },
    {
      id: 'evt-2',
      '@timestamp': '2026-06-19T22:10:03Z',
      event: 'failed',
      domain: { name: 'acme.com' },
      recipient: 'c@d.com',
      'delivery-status': { code: 550, message: '550 IP listed' }
    }
  ],
  pagination: {}
};

// timestamp:desc returns newest-first; mocks should mirror that ordering.
const EVENTS_RESPONSE_DESC = {
  items: [...EVENTS_RESPONSE.items].reverse(),
  pagination: {}
};

function requestBody(request: RecordedRequest): any {
  return JSON.parse(request.body);
}

test('events single-fetch emits NDJSON via the real (mocked) API path', async () => {
  const server = await startMockServer([{ method: 'POST', path: '/v1/analytics/logs', json: EVENTS_RESPONSE }]);
  try {
    const result = await runCli(['events', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).domain, 'acme.com');
    assert.equal(server.requests[0]!.path, '/v1/analytics/logs');
    assert.equal(server.requests[0]!.method, 'POST');
    assert.match(String(server.requests[0]!.headers.authorization), /^Basic /);
    const body = requestBody(server.requests[0]!);
    assert.deepEqual(body.events, ['delivered', 'failed', 'opened', 'clicked', 'complained']);
    assert.deepEqual(body.filter.AND[0], {
      attribute: 'domain',
      comparator: '=',
      values: [{ label: 'acme.com', value: 'acme.com' }]
    });
    assert.equal(body.pagination.limit, 10);
    assert.equal(body.pagination.sort, 'timestamp:desc');
  } finally {
    await server.close();
  }
});

test('events single-fetch forwards --limit and custom --filter to the API', async () => {
  const server = await startMockServer([{ method: 'POST', path: '/v1/analytics/logs', json: { items: [EVENTS_RESPONSE.items[0]], pagination: {} } }]);
  try {
    const result = await runCli(
      ['events', '--domain', 'acme.com', '--limit', '1', '--filter', 'delivered,failed', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const body = requestBody(server.requests[0]!);
    assert.equal(body.pagination.limit, 1);
    assert.deepEqual(body.events, ['delivered', 'failed']);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    await server.close();
  }
});

test('events --tail shows a backlog (timestamp:desc) then polls forward (timestamp:asc + start/end)', async () => {
  const server = await startMockServer([{ method: 'POST', path: '/v1/analytics/logs', json: EVENTS_RESPONSE_DESC }]);
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
        const forwardPolls = server.requests.filter((r) => requestBody(r).pagination.sort === 'timestamp:asc');
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

    const bodies = server.requests.map((r) => requestBody(r));
    assert.ok(bodies.some((body) => body.pagination.sort === 'timestamp:desc'), 'backlog request should use timestamp:desc');
    const poll = bodies.find((body) => body.pagination.sort === 'timestamp:asc');
    assert.ok(poll, 'should issue a forward poll with timestamp:asc');
    assert.ok(poll!.start, 'forward poll should carry a start anchor');
    assert.ok(poll!.end, 'forward poll should carry an end anchor');
    assert.match(poll!.start!, / -0000$/, 'forward poll start should use Mailgun Logs RFC2822 offset');
    assert.match(poll!.end!, / -0000$/, 'forward poll end should use Mailgun Logs RFC2822 offset');
    assert.equal(poll!.pagination.limit, 10, 'forward poll should pass limit');
    assert.equal(bodies[0]!.pagination.sort, 'timestamp:desc');

    const lines = stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'tail backlog should emit each event once despite repeat polls');
    assert.equal(JSON.parse(lines[0]!).event, 'delivered');
    assert.equal(JSON.parse(lines[1]!).event, 'failed');
  } finally {
    await server.close();
  }
});

test('events --tail resets the forward cursor after pagination.next is exhausted', async () => {
  let mockServer: Awaited<ReturnType<typeof startMockServer>>;
  let forwardWithoutPage = 0;
  mockServer = await startMockServer([
    {
      method: 'POST',
      path: '/v1/analytics/logs',
      json: (req: RecordedRequest) => {
        const body = requestBody(req);
        if (body.pagination.sort === 'timestamp:desc') {
          return { items: [EVENTS_RESPONSE_DESC.items[0]], pagination: {} };
        }
        if (body.pagination.token === 'page-2') {
          return { items: [], pagination: {} };
        }
        forwardWithoutPage += 1;
        if (forwardWithoutPage === 1) {
          return {
            items: [EVENTS_RESPONSE.items[1]],
            pagination: { next: 'page-2' }
          };
        }
        return { items: [], pagination: {} };
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
        const forward = mockServer.requests
          .map((r) => requestBody(r))
          .filter((body) => body.pagination.sort === 'timestamp:asc');
        if (
          forward.some((body) => body.pagination.token === 'page-2') &&
          forward.some((body) => body.pagination.token === undefined) &&
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

    assert.ok(sawReset, 'should start a new forward poll cycle after pagination.next is exhausted');
    const forward = mockServer.requests
      .map((r) => requestBody(r))
      .filter((body) => body.pagination.sort === 'timestamp:asc');
    assert.ok(forward.some((body) => body.pagination.token === 'page-2'), 'should follow pagination.next within a poll cycle');
    const resetPolls = forward.filter((body) => body.pagination.token === undefined);
    assert.ok(resetPolls.length >= 2, 'second forward cycle should use a fresh poll window, not a stale page token');
    assert.ok(resetPolls[resetPolls.length - 1]!.start, 'reset poll should carry an updated begin anchor');
  } finally {
    await mockServer.close();
  }
});

test('events rejects --limit over 100 with exit 2', async () => {
  const result = await runCli(['events', '--domain', 'acme.com', '--limit', '101', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--limit must be 100 or less/);
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
  const server = await startMockServer([{ method: 'POST', path: '/v1/analytics/logs', status: 403, json: { message: 'forbidden' } }]);
  try {
    const result = await runCli(['events', '--domain', 'acme.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /403 for logs/);
    assert.match(result.stderr, /"message":"forbidden"/);
  } finally {
    await server.close();
  }
});

test('agent-context lists all production commands and excludes retired health/investigate', async () => {
  const result = await runCli(['agent-context']);
  assert.equal(result.code, 0);
  const ctx = JSON.parse(result.stdout);
  assert.equal(ctx.schema_version, '1.2');
  const keys = Object.keys(ctx.commands);
  assert.deepEqual(
    keys,
    ['agent-context', 'events', 'inbox-placement list', 'inbox-placement result', 'inbox-placement run', 'metrics summary', 'preview clients', 'preview issues', 'preview list', 'preview render', 'preview result', 'preview run', 'validate-email']
  );
  assert.ok(!keys.includes('health'));
  assert.ok(!keys.includes('investigate'));
  assert.equal(ctx.commands.events.product, 'Send');
  assert.equal(ctx.commands['metrics summary'].product, 'Send');
  assert.equal(ctx.commands['metrics summary'].mcp_tool, 'get_metrics_summary');
  assert.equal(ctx.commands['preview run'].mode, 'write');
  assert.equal(ctx.commands['preview run'].mcp_tool, 'run_email_preview_qa');
  assert.equal(ctx.commands['inbox-placement run'].mode, 'write');
  assert.equal(ctx.commands['inbox-placement run'].product, 'Optimize');
});

test('invalid region exits 2', async () => {
  const result = await runCli(['metrics', 'summary', '--domain', 'acme.com', '--region', 'apac', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /invalid region/);
});
