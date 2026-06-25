import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePreviewStatus, normalizePreviewList, normalizePreviewResult } from './inspect.js';
import {
  PREVIEW_LIST,
  PREVIEW_LIST_EMPTY,
  PREVIEW_RESULT_COMPLETE,
  PREVIEW_RESULT_PARTIAL,
  PREVIEW_RESULT_PROCESSING
} from '../fixtures/inspect.js';

test('list maps id/subject/from/date and leaves status null', () => {
  const out = normalizePreviewList(PREVIEW_LIST);
  assert.equal(out.tests.length, 2);
  assert.equal(out.tests[0]!.test_id, 'preview_123');
  assert.equal(out.tests[0]!.from, 'Marketing <news@example.com>');
  assert.equal(out.tests[0]!.created_at, '2026-06-24T14:02:00.000Z');
  assert.equal(out.tests[0]!.status, null);
  assert.deepEqual(out.data_gaps, []);
});

test('empty list returns []', () => {
  assert.deepEqual(normalizePreviewList(PREVIEW_LIST_EMPTY).tests, []);
});

test('status derivation is mechanical', () => {
  assert.equal(derivePreviewStatus(3, 0, 0), 'complete');
  assert.equal(derivePreviewStatus(1, 2, 0), 'processing');
  assert.equal(derivePreviewStatus(2, 0, 1), 'partial');
  assert.equal(derivePreviewStatus(0, 0, 0), 'unknown');
});

test('complete result includes all clients and content_checking availability', () => {
  const out = normalizePreviewResult('preview_123', PREVIEW_RESULT_COMPLETE);
  assert.equal(out.status, 'complete');
  assert.equal(out.summary.total_clients, 3);
  assert.equal(out.clients.length, 3);
  assert.equal(out.content_checking.link_validation.available, true);
  assert.equal(out.content_checking.link_validation.href, '/v1/inspect/links/abc123');
  assert.equal(out.content_checking.image_validation.available, true);
  assert.equal(out.content_checking.accessibility.available, false);
  assert.equal(out.content_checking.accessibility.href, null);
  assert.deepEqual(out.data_gaps, []);
});

test('partial result marks bounced client', () => {
  const out = normalizePreviewResult('preview_123', PREVIEW_RESULT_PARTIAL);
  assert.equal(out.status, 'partial');
  assert.equal(out.summary.bounced, 1);
  assert.ok(out.clients.some((c) => c.status === 'bounced' && c.id === 'lotus_notes'));
});

test('processing result has processing status', () => {
  const out = normalizePreviewResult('preview_123', PREVIEW_RESULT_PROCESSING);
  assert.equal(out.status, 'processing');
  assert.equal(out.summary.processing, 2);
});
