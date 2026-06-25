import test from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, runCli } from './mock-server.js';
import { VALIDATE_DELIVERABLE_TYPO, VALIDATE_UNDELIVERABLE } from '../fixtures/validate.js';

test('validate-email success path: GET path, query, basic auth', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/address/validate', json: VALIDATE_DELIVERABLE_TYPO }]);
  try {
    const result = await runCli(
      ['validate-email', '--address', 'john_snow@yaho.com', '--provider-lookup', 'true', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const json = JSON.parse(result.stdout);
    assert.equal(json.result, 'deliverable');
    assert.equal(json.did_you_mean, 'john_snow@yahoo.com');

    const req = server.requests[0]!;
    assert.equal(req.path, '/v4/address/validate');
    assert.equal(req.query.get('address'), 'john_snow@yaho.com');
    assert.equal(req.query.get('provider_lookup'), 'true');
    assert.match(String(req.headers.authorization), /^Basic /);
  } finally {
    await server.close();
  }
});

test('validate-email positional address works', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/address/validate', json: VALIDATE_DELIVERABLE_TYPO }]);
  try {
    const result = await runCli(['validate-email', 'john_snow@yaho.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.query.get('address'), 'john_snow@yaho.com');
  } finally {
    await server.close();
  }
});

test('validate-email undeliverable exits 0', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/address/validate', json: VALIDATE_UNDELIVERABLE }]);
  try {
    const result = await runCli(['validate-email', 'noreply@invalid-domain.test', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).result, 'undeliverable');
  } finally {
    await server.close();
  }
});

test('validate-email conflicting positional/flag exits 2 before API call', async () => {
  const result = await runCli(['validate-email', 'a@b.com', '--address', 'c@d.com', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /conflicting address arguments/);
});

test('validate-email bad provider-lookup exits 2', async () => {
  const result = await runCli(['validate-email', 'a@b.com', '--provider-lookup', 'yes', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--provider-lookup requires an explicit true or false/);
});

test('validate-email 403 surfaces Validate guidance', async () => {
  const server = await startMockServer([{ method: 'GET', path: '/v4/address/validate', status: 403, json: { message: 'no' } }]);
  try {
    const result = await runCli(['validate-email', 'a@b.com', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /403 - your plan or API key may not include Validate/);
  } finally {
    await server.close();
  }
});
