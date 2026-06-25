import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegion } from './runtime.js';
import { regionBaseUrl, REGION_HOSTS } from './mailgun.js';
import { UsageError } from './output.js';

test('region defaults to us', () => {
  delete process.env.MAILGUN_API_REGION;
  assert.equal(resolveRegion(undefined), 'us');
});

test('region accepts us/eu case-insensitively', () => {
  assert.equal(resolveRegion('US'), 'us');
  assert.equal(resolveRegion('Eu'), 'eu');
});

test('invalid region throws UsageError', () => {
  assert.throws(() => resolveRegion('apac'), UsageError);
});

test('region falls back to env var', () => {
  process.env.MAILGUN_API_REGION = 'eu';
  try {
    assert.equal(resolveRegion(undefined), 'eu');
  } finally {
    delete process.env.MAILGUN_API_REGION;
  }
});

test('region host mapping (no test override)', () => {
  delete process.env.MAILGUN_TEST_BASE_URL;
  assert.equal(regionBaseUrl('us'), REGION_HOSTS.us);
  assert.equal(regionBaseUrl('eu'), 'https://api.eu.mailgun.net');
});
