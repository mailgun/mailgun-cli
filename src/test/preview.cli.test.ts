import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, runCli } from './mock-server.js';
import { PREVIEW_LIST, PREVIEW_LIST_EMPTY, PREVIEW_RESULT_PARTIAL, PREVIEW_RESULT_PROCESSING, PREVIEW_403 } from '../fixtures/inspect.js';
import { CLIENTS_CATALOG } from '../fixtures/email-preview-qa-contract.js';

test('preview list success: limit maps to results query param', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests', json: PREVIEW_LIST }]);
  try {
    const result = await runCli(['preview', 'list', '--limit', '10', '--subject', 'June', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.tests[0].test_id, 'preview_123');
    const req = server.requests[0]!;
    assert.equal(req.query.get('results'), '10');
    assert.equal(req.query.get('subject'), 'June');
    assert.equal(req.query.get('page'), null);
  } finally {
    await server.close();
  }
});

test('preview list empty exits 0 with tests: []', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests', json: PREVIEW_LIST_EMPTY }]);
  try {
    const result = await runCli(['preview', 'list', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).tests, []);
  } finally {
    await server.close();
  }
});

test('preview result partial exits 0 with all clients in JSON', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests/', json: PREVIEW_RESULT_PARTIAL }]);
  try {
    const result = await runCli(['preview', 'result', '--test-id', 'preview_123', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, 'partial');
    assert.equal(json.clients.length, 3);
    assert.equal(server.requests[0]!.path, '/v2/preview/tests/preview_123');
  } finally {
    await server.close();
  }
});

test('preview result processing exits 0', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests/', json: PREVIEW_RESULT_PROCESSING }]);
  try {
    const result = await runCli(['preview', 'result', '--test-id', 'preview_123', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).status, 'processing');
  } finally {
    await server.close();
  }
});

test('preview result accepts a positional test id', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests/', json: PREVIEW_RESULT_PARTIAL }]);
  try {
    const result = await runCli(['preview', 'result', 'preview_123', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.path, '/v2/preview/tests/preview_123');
  } finally {
    await server.close();
  }
});

test('preview result conflicting positional/flag exits 2', async () => {
  const result = await runCli(['preview', 'result', 'a', '--test-id', 'b', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /conflicting --test-id arguments/);
});

test('preview result missing id exits 2 with actionable message', async () => {
  const result = await runCli(['preview', 'result', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /a test id is required/);
});

test('preview clients normalizes the catalog', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v1/preview/tests/clients', json: CLIENTS_CATALOG }]);
  try {
    const result = await runCli(['preview', 'clients', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.path, '/v1/preview/tests/clients');
    const json = JSON.parse(result.stdout);
    assert.ok(Array.isArray(json.clients));
    assert.equal(json.clients.length, 4);
    assert.equal(json.clients[0].id, 'apple_mail');
    const gmail = json.clients.find((c: { id: string }) => c.id === 'gmail_chrome');
    assert.equal(gmail.default, true);
    assert.deepEqual(json.data_gaps, []);
  } finally {
    await server.close();
  }
});

test('preview clients requires an api key (exit 2)', async () => {
  const result = await runCli(['preview', 'clients', '--json'], {});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /MAILGUN_API_KEY/);
});

test('preview 403 surfaces API response', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v2/preview/tests', status: 403, json: PREVIEW_403 }]);
  try {
    const result = await runCli(['preview', 'list', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /403 for preview tests/);
    assert.match(result.stderr, /Email Preview is not enabled/);
  } finally {
    await server.close();
  }
});
