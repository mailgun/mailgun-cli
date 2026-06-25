import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, runCli } from './mock-server.js';
import { INBOX_LIST, INBOX_LIST_EMPTY, INBOX_RESULT_COMPLETE, INBOX_RESULT_PROCESSING, INBOX_403 } from '../fixtures/optimize.js';

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

test('inbox-placement 403 surfaces Optimize guidance', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/inbox/results', status: 403, json: INBOX_403 }]);
  try {
    const result = await runCli(['inbox-placement', 'list', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /403 - your account may not include Inbox Placement/);
  } finally {
    await server.close();
  }
});
