import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreviewList, normalizePreviewClients } from './preview.js';
import {
  normalizeRenderState,
  extractCheckResultIds,
  countLinkValidationIssues,
  countImageValidationIssues,
  countAccessibilityIssues,
  countCodeAnalysisIssues,
  buildPreviewQaOutput,
  type CheckFetch
} from './preview-qa.js';
import { PREVIEW_LIST, PREVIEW_LIST_EMPTY } from '../../../fixtures/inspect.js';
import {
  RENDER_COMPLETE,
  RENDER_PROCESSING,
  RENDER_PARTIAL,
  RENDER_STRAGGLER,
  RENDER_EMPTY,
  RENDER_CHECK_REFERENCE_MISSING,
  LINK_RESULT,
  IMAGE_RESULT,
  ACCESSIBILITY_RESULT,
  CODE_ANALYSIS_RESULT,
  CLIENTS_CATALOG
} from '../../../fixtures/email-preview-qa-contract.js';

// ---- list ----

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

// ---- client catalog ----

test('client catalog normalizes to a sorted array of entries', () => {
  const out = normalizePreviewClients(CLIENTS_CATALOG);
  assert.equal(out.clients.length, 4);
  assert.deepEqual(
    out.clients.map((c) => c.id),
    ['apple_mail', 'gmail_chrome', 'lotus_notes', 'outlook_win']
  );
  const gmail = out.clients.find((c) => c.id === 'gmail_chrome')!;
  assert.equal(gmail.client, 'Gmail');
  assert.equal(gmail.default, true);
  assert.equal(gmail.free, true);
  assert.deepEqual(out.data_gaps, []);
});

test('empty client catalog reports a data gap', () => {
  const out = normalizePreviewClients({ clients: {} });
  assert.deepEqual(out.clients, []);
  assert.equal(out.data_gaps[0]!.code, 'preview_clients_catalog_empty');
});

// ---- QA render state ----

test('render state derivation is mechanical', () => {
  assert.equal(normalizeRenderState(RENDER_COMPLETE).status, 'complete');
  assert.equal(normalizeRenderState(RENDER_PROCESSING).status, 'processing');
  assert.equal(normalizeRenderState(RENDER_PARTIAL).status, 'partial');
  assert.equal(normalizeRenderState(RENDER_EMPTY).status, 'unknown');
});

// ---- QA counters (must match the MCP composite on the shared fixtures) ----

test('link validation counts', () => {
  const c = countLinkValidationIssues(LINK_RESULT);
  assert.equal(c.passes, 2);
  assert.equal(c.failures, 2);
  assert.equal(c.informational, 1);
  assert.deepEqual(c.by_severity, { critical: 1, unknown: 1 });
});

test('image validation counts', () => {
  const c = countImageValidationIssues(IMAGE_RESULT);
  assert.equal(c.passes, 1);
  assert.equal(c.failures, 1);
  assert.deepEqual(c.by_severity, { moderate: 1 });
});

test('accessibility counts instances (headline) and rules (secondary)', () => {
  const c = countAccessibilityIssues(ACCESSIBILITY_RESULT);
  assert.equal(c.failures, 3);
  assert.equal(c.failure_rules, 2);
  assert.equal(c.needs_review, 1);
  assert.equal(c.needs_review_rules, 1);
  assert.deepEqual(c.failures_by_severity, { serious: 2, critical: 1 });
  assert.deepEqual(c.needs_review_by_severity, { moderate: 1 });
});

test('code analysis uses meta.count and passes support aggregates through', () => {
  const c = countCodeAnalysisIssues(CODE_ANALYSIS_RESULT);
  assert.equal(c.count, 2);
  assert.equal(c.instances, 3);
  assert.deepEqual(c.by_feature, { 'html-width': 2, 'target-attribute': 1 });
  assert.deepEqual(c.application_support, CODE_ANALYSIS_RESULT.meta.application_support);
  assert.deepEqual(c.inbox_provider_support, CODE_ANALYSIS_RESULT.meta.inbox_provider_support);
  assert.deepEqual(c.market_support, CODE_ANALYSIS_RESULT.meta.market_support);
});

// ---- QA output builder ----

const okFetch = (payload: unknown): CheckFetch => ({ status: 'ok', payload });

test('complete render aggregates counts and references', () => {
  const refs = extractCheckResultIds(RENDER_COMPLETE);
  const out = buildPreviewQaOutput({
    testId: 'preview_test_001',
    render: RENDER_COMPLETE,
    refs,
    fetches: {
      link_validation: okFetch(LINK_RESULT),
      image_validation: okFetch(IMAGE_RESULT),
      accessibility: okFetch(ACCESSIBILITY_RESULT),
      code_analysis: okFetch(CODE_ANALYSIS_RESULT)
    },
    timedOut: false
  });

  assert.equal(out.status, 'complete');
  assert.equal(out.timed_out, false);
  assert.deepEqual(out.summary, { total_clients: 3, completed: 3, processing: 0, bounced: 0 });
  assert.equal(out.checks.link_validation.status, 'complete');
  assert.equal(out.checks.link_validation.result_id, 'link_001');
  assert.equal(out.checks.accessibility.failures, 3);
  assert.equal(out.checks.accessibility.needs_review, 1);
  assert.equal(out.checks.code_analysis.count, 2);
  assert.equal(out.checks.code_analysis.instances, 3);
  assert.equal(out.issue_counts.total, 6);
  assert.deepEqual(out.issue_counts.by_check, {
    link_validation: 2,
    image_validation: 1,
    accessibility: 3
  });
  assert.deepEqual(out.issue_counts.by_severity, { critical: 2, unknown: 1, moderate: 1, serious: 2 });
  // The code-analysis formula gate is resolved (meta.count); no such data gap.
  assert.ok(!out.data_gaps.some((g) => g.code === 'code_analysis_count_formula_unsupported'));
  assert.deepEqual(out.data_gaps, []);
});

test('render straggler does not block; reported as render_incomplete', () => {
  const refs = extractCheckResultIds(RENDER_STRAGGLER);
  const out = buildPreviewQaOutput({
    testId: 'preview_test_001',
    render: RENDER_STRAGGLER,
    refs,
    fetches: {
      link_validation: okFetch(LINK_RESULT),
      image_validation: okFetch(IMAGE_RESULT),
      accessibility: okFetch(ACCESSIBILITY_RESULT),
      code_analysis: okFetch(CODE_ANALYSIS_RESULT)
    },
    timedOut: false
  });
  assert.equal(out.timed_out, false);
  assert.equal(out.summary.processing, 1);
  assert.equal(out.checks.link_validation.status, 'complete');
  assert.ok(out.data_gaps.some((g) => g.code === 'render_incomplete'));
  assert.ok(!out.data_gaps.some((g) => g.code === 'workflow_timed_out'));
});

test('missing reference yields unavailable + data gap; not_requested stays', () => {
  const refs = extractCheckResultIds(RENDER_CHECK_REFERENCE_MISSING);
  const out = buildPreviewQaOutput({
    testId: 'preview_test_013',
    render: RENDER_CHECK_REFERENCE_MISSING,
    refs,
    fetches: {
      link_validation: okFetch(LINK_RESULT),
      image_validation: { status: 'not_fetched' },
      accessibility: { status: 'not_fetched' },
      code_analysis: okFetch(CODE_ANALYSIS_RESULT)
    },
    timedOut: false
  });
  assert.equal(out.checks.image_validation.status, 'unavailable');
  assert.equal(out.checks.accessibility.status, 'not_requested');
  assert.ok(out.data_gaps.some((g) => g.code === 'check_reference_missing'));
});

test('timeout adds a workflow_timed_out data gap and processing lifecycle', () => {
  const refs = extractCheckResultIds(RENDER_PROCESSING);
  const out = buildPreviewQaOutput({
    testId: 'preview_test_005',
    render: RENDER_PROCESSING,
    refs,
    fetches: {
      link_validation: { status: 'not_fetched' },
      image_validation: { status: 'not_fetched' },
      accessibility: { status: 'not_fetched' },
      code_analysis: { status: 'not_fetched' }
    },
    timedOut: true
  });
  assert.equal(out.status, 'processing');
  assert.equal(out.timed_out, true);
  assert.equal(out.checks.link_validation.status, 'processing');
  assert.ok(out.data_gaps.some((g) => g.code === 'workflow_timed_out'));
});
