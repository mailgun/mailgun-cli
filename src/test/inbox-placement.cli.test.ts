import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, runCli } from './mock-server.js';
import {
  INBOX_CREATE_RESPONSE,
  INBOX_LIST,
  INBOX_LIST_EMPTY,
  INBOX_RESULT_COMPLETE,
  INBOX_RESULT_PROCESSING,
  INBOX_403
} from '../fixtures/optimize.js';

const HTML_SECRET = 'SECRET_HTML_MARKER_9f8a';
const SAMPLE_HTML = `<html><body><h1>Hi</h1><p>${HTML_SECRET}</p></body></html>`;

function withHtmlFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-run-'));
  const path = join(dir, 'email.html');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('inbox-placement list success: query params and ID-first output', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results', json: INBOX_LIST }]);
  try {
    const result = await runCli(
      ['inbox-placement', 'list', '--limit', '10', '--provider', 'gmail.com', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.results[0].result_id, 'result_123');
    const req = server.requests[0]!;
    assert.equal(req.query.get('limit'), '10');
    assert.equal(req.query.get('provider'), 'gmail.com');
  } finally {
    await server.close();
  }
});

test('inbox-placement list empty exits 0 with results: []', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results', json: INBOX_LIST_EMPTY }]);
  try {
    const result = await runCli(['inbox-placement', 'list', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).results, []);
  } finally {
    await server.close();
  }
});

test('inbox-placement list rejects --limit over 50 with exit 2', async () => {
  const result = await runCli(['inbox-placement', 'list', '--limit', '51', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--limit must be a positive integer from 1 to 50/);
});

test('inbox-placement list rejects decimal --limit', async () => {
  const result = await runCli(['inbox-placement', 'list', '--limit', '2.5', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
});

test('inbox-placement result success: path and provider query', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results/', json: INBOX_RESULT_COMPLETE }]);
  try {
    const result = await runCli(
      ['inbox-placement', 'result', '--result', 'result_123', '--provider', 'gmail.com', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.placement.inbox_rate, 0.857);
    const req = server.requests[0]!;
    assert.equal(req.path, '/v4/inbox/results/result_123');
    assert.equal(req.query.get('provider'), 'gmail.com');
  } finally {
    await server.close();
  }
});

test('inbox-placement result processing exits 0', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results/', json: INBOX_RESULT_PROCESSING }]);
  try {
    const result = await runCli(['inbox-placement', 'result', '--result', 'result_999', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, 'processing');
  } finally {
    await server.close();
  }
});

test('inbox-placement result accepts a positional result id', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results/', json: INBOX_RESULT_COMPLETE }]);
  try {
    const result = await runCli(['inbox-placement', 'result', 'result_123', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.path, '/v4/inbox/results/result_123');
  } finally {
    await server.close();
  }
});

test('inbox-placement result conflicting positional/flag exits 2', async () => {
  const result = await runCli(['inbox-placement', 'result', 'a', '--result', 'b', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /conflicting --result arguments/);
});

test('inbox-placement result missing id exits 2 with actionable message', async () => {
  const result = await runCli(['inbox-placement', 'result', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /a result id is required/);
});

test('inbox-placement 403 surfaces API response', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results', status: 403, json: INBOX_403 }]);
  try {
    const result = await runCli(['inbox-placement', 'list', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /403 for inbox placement results/);
    assert.match(result.stderr, /Inbox Placement is not enabled/);
  } finally {
    await server.close();
  }
});

// --- inbox-placement run (write) ---

const CREATE_ROUTES = [
  { method: 'POST', path: '/v4/inbox/tests', status: 202, json: INBOX_CREATE_RESPONSE },
  { method: 'GET', path: '/v4/inbox/results/', json: INBOX_RESULT_COMPLETE }
];

test('inbox-placement run --dry-run makes zero network calls, needs no api key, and never prints HTML', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--dry-run',
        '--json'
      ],
      {},
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(server.requests.length, 0, 'dry run must not touch the network');
    const json = JSON.parse(result.stdout);
    assert.equal(json.dry_run, true);
    assert.equal(json.action, 'run_inbox_placement_test');
    assert.equal(json.will_consume_quota, true);
    assert.equal(json.will_send_to_seeds, true);
    assert.equal(json.uses_all_providers, true);
    assert.equal(json.content.type, 'html');
    assert.equal(json.content.path, file.path);
    assert.equal(json.content.bytes, Buffer.byteLength(SAMPLE_HTML, 'utf8'));
    assert.match(json.content.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!result.stdout.includes(HTML_SECRET), 'dry run must never print HTML content');
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('inbox-placement run human dry-run warns about sending to seeds and quota', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli([
      'inbox-placement',
      'run',
      '--from',
      'news@example.com',
      '--subject',
      'June',
      '--html',
      file.path,
      '--dry-run'
    ]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /send to seed addresses/i);
    assert.match(result.stdout, /consume quota/i);
  } finally {
    file.cleanup();
  }
});

test('inbox-placement run --yes issues exactly one POST then polls to a complete summary', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--providers',
        'gmail.com,yahoo.com',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const posts = server.requests.filter((r) => r.method === 'POST' && r.path === '/v4/inbox/tests');
    assert.equal(posts.length, 1, 'exactly one create POST');
    const body = JSON.parse(posts[0]!.body);
    assert.equal(body.from, 'news@example.com');
    assert.equal(body.subject, 'June');
    assert.equal(body.html, SAMPLE_HTML);
    assert.deepEqual(body.provider_filter, ['gmail.com', 'yahoo.com']);
    const json = JSON.parse(result.stdout);
    assert.equal(json.result_id, 'result_123');
    assert.equal(json.status, 'complete');
    assert.equal(json.timed_out, false);
    assert.equal(json.mailing_list, 'ibp-seed@example.com');
    assert.equal(json.placement.inbox_rate, 0.857);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('inbox-placement run --timeout 0 returns a processing result with workflow_timed_out', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer([
    { method: 'POST', path: '/v4/inbox/tests', status: 202, json: { result_id: 'result_999' } },
    { method: 'GET', path: '/v4/inbox/results/', json: INBOX_RESULT_PROCESSING }
  ]);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--timeout',
        '0',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.result_id, 'result_999');
    assert.equal(json.status, 'processing');
    assert.equal(json.timed_out, true);
    assert.ok(json.data_gaps.some((gap: { code: string }) => gap.code === 'workflow_timed_out'));
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('inbox-placement run treats a create 5xx as non-retryable', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer([
    {
      method: 'POST',
      path: '/v4/inbox/tests',
      status: 500,
      json: { message: 'Internal server error' }
    }
  ]);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 1);
    assert.equal(server.requests.filter((request) => request.method === 'POST').length, 1);
    assert.match(result.stderr, /no second create was attempted/i);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('inbox-placement run rejects both --dry-run and --yes (exit 2, before network)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--dry-run',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 2);
    assert.equal(server.requests.length, 0);
    assert.match(result.stderr, /cannot be combined/);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('inbox-placement run with neither --dry-run nor --yes exits 2', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      ['inbox-placement', 'run', '--from', 'news@example.com', '--subject', 'June', '--html', file.path, '--json'],
      { MAILGUN_API_KEY: 'k' }
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--dry-run to preview .* or --yes to execute/);
  } finally {
    file.cleanup();
  }
});

test('inbox-placement run rejects missing content source before network (exit 2)', async () => {
  const result = await runCli(
    ['inbox-placement', 'run', '--from', 'news@example.com', '--subject', 'June', '--dry-run', '--json'],
    {}
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /exactly one content source is required/);
});

test('inbox-placement run rejects conflicting content sources (exit 2)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--template-name',
        'welcome',
        '--dry-run',
        '--json'
      ],
      {}
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /exactly one content source/);
  } finally {
    file.cleanup();
  }
});

test('inbox-placement run dry-run supports --template-name without an HTML file', async () => {
  const result = await runCli(
    [
      'inbox-placement',
      'run',
      '--from',
      'news@example.com',
      '--subject',
      'June',
      '--template-name',
      'welcome',
      '--dry-run',
      '--json'
    ],
    {}
  );
  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(json.content, { type: 'template_name', template_name: 'welcome' });
});

test('inbox-placement run rejects a blank --from (exit 2)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      ['inbox-placement', 'run', '--from', '   ', '--subject', 'June', '--html', file.path, '--dry-run', '--json'],
      {}
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--from is required/);
  } finally {
    file.cleanup();
  }
});

test('inbox-placement run rejects blank entries in --providers (exit 2)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      [
        'inbox-placement',
        'run',
        '--from',
        'news@example.com',
        '--subject',
        'June',
        '--html',
        file.path,
        '--providers',
        'gmail.com,,yahoo.com',
        '--dry-run',
        '--json'
      ],
      {}
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /blank provider domain/);
  } finally {
    file.cleanup();
  }
});
