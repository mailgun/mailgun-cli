import test from 'node:test';
import assert from 'node:assert/strict';
import { buildValidateQuery, normalizeValidation, resolveAddress } from './address.js';
import { UsageError } from '../../cli/output.js';
import { VALIDATE_DELIVERABLE_TYPO, VALIDATE_MINIMAL, VALIDATE_UNDELIVERABLE } from '../../../fixtures/validate.js';

test('resolveAddress prefers --address when equal to positional', () => {
  assert.equal(resolveAddress('a@b.com', 'a@b.com'), 'a@b.com');
});

test('resolveAddress uses positional when no flag', () => {
  assert.equal(resolveAddress('a@b.com', undefined), 'a@b.com');
});

test('resolveAddress conflict throws UsageError', () => {
  assert.throws(() => resolveAddress('a@b.com', 'c@d.com'), UsageError);
});

test('resolveAddress missing throws UsageError', () => {
  assert.throws(() => resolveAddress(undefined, undefined), UsageError);
});

test('buildValidateQuery includes provider_lookup only when set', () => {
  assert.deepEqual(buildValidateQuery({ address: 'a@b.com' }), { address: 'a@b.com' });
  assert.deepEqual(buildValidateQuery({ address: 'a@b.com', providerLookup: true }), { address: 'a@b.com', provider_lookup: true });
});

test('normalizes deliverable typo and renames reason to reasons', () => {
  const r = normalizeValidation('john_snow@yaho.com', VALIDATE_DELIVERABLE_TYPO);
  assert.equal(r.result, 'deliverable');
  assert.equal(r.did_you_mean, 'john_snow@yahoo.com');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.data_gaps, []);
});

test('minimal response tolerated with data gap for missing risk', () => {
  const r = normalizeValidation('someone@example.com', VALIDATE_MINIMAL);
  assert.equal(r.result, 'deliverable');
  assert.equal(r.risk, null);
  assert.equal(r.data_gaps.length, 1);
  assert.equal(r.data_gaps[0]!.code, 'validation_detail_limited');
});

test('undeliverable risky response normalizes reasons', () => {
  const r = normalizeValidation('noreply@invalid-domain.test', VALIDATE_UNDELIVERABLE);
  assert.equal(r.result, 'undeliverable');
  assert.equal(r.risk, 'high');
  assert.deepEqual(r.reasons, ['mailbox_does_not_exist']);
});
