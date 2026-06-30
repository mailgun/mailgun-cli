import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInboxList, normalizeInboxResult } from './inbox-placement.js';
import {
  INBOX_LIST,
  INBOX_LIST_EMPTY,
  INBOX_RESULT_COMPLETE,
  INBOX_RESULT_PROVIDER,
  INBOX_RESULT_PROCESSING
} from '../../../fixtures/optimize.js';

test('list normalizes nested basictestresult fields', () => {
  const out = normalizeInboxList(INBOX_LIST);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0]!.result_id, 'result_123');
  assert.equal(out.results[0]!.subject, 'June campaign');
  assert.equal(out.results[0]!.created_at, '2026-06-24T14:22:00.000Z');
  assert.equal(out.results[1]!.status, 'processing');
  assert.deepEqual(out.data_gaps, []);
});

test('empty list returns [] and no gaps', () => {
  const out = normalizeInboxList(INBOX_LIST_EMPTY);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.data_gaps, []);
});

test('complete result aggregates placement from providers and computes inbox_rate', () => {
  const out = normalizeInboxResult('result_123', INBOX_RESULT_COMPLETE);
  assert.equal(out.status, 'complete');
  assert.deepEqual(out.placement, { inbox: 42, spam: 6, missing: 1, pending: 0, inbox_rate: 0.857 });
  assert.equal(out.providers.length, 3);
  assert.equal(out.providers[0]!.inbox_rate, 0.8);
  assert.deepEqual(out.spamassassin, { is_spam: false, score: 2.1, required: 5 });
  assert.deepEqual(out.data_gaps, []);
});

test('single-provider result keeps provider-level facts', () => {
  const out = normalizeInboxResult('result_123', INBOX_RESULT_PROVIDER);
  assert.equal(out.providers.length, 1);
  assert.equal(out.placement.inbox_rate, 0.8);
});

test('processing result exits with placement_pending gap and no providers', () => {
  const out = normalizeInboxResult('result_999', INBOX_RESULT_PROCESSING);
  assert.equal(out.status, 'processing');
  assert.deepEqual(out.providers, []);
  assert.equal(out.placement.inbox_rate, null);
  assert.equal(out.data_gaps[0]!.code, 'placement_pending');
});
