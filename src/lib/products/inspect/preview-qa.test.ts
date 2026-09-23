import test from 'node:test';
import assert from 'node:assert/strict';
import { pollPreviewQa, buildPreviewQaOutput } from './preview-qa.js';
import type { PollDeps } from '../../core/write-run.js';
import { CliError } from '../../cli/output.js';
import {
  RENDER_COMPLETE,
  RENDER_STRAGGLER,
  RENDER_CHECK_LIFECYCLE,
  LINK_RESULT,
  IMAGE_RESULT,
  ACCESSIBILITY_RESULT,
  CODE_ANALYSIS_RESULT,
  CODE_ANALYSIS_PROCESSING
} from '../../../fixtures/email-preview-qa-contract.js';

type Route = unknown | (() => unknown);

// Deterministic deps: `sleep` advances a virtual clock so poll loops terminate
// without real timers; `request` resolves fixtures (or throws 404) by path.
function fakeDeps(routes: Record<string, Route>): { deps: PollDeps; requests: string[] } {
  let current = 0;
  const requests: string[] = [];
  const deps: PollDeps = {
    request: async (method, path) => {
      requests.push(`${method} ${path}`);
      const route = routes[path];
      if (route === undefined) throw new CliError('not found', 1, 404);
      return typeof route === 'function' ? (route as () => unknown)() : route;
    },
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    }
  };
  return { deps, requests };
}

const STATUS_PATH = '/v2/preview/tests/preview_test_001';
const RESULT_ROUTES = {
  '/v1/inspect/links/link_001': LINK_RESULT,
  '/v1/inspect/images/image_001': IMAGE_RESULT,
  '/v1/inspect/accessibility/access_001': ACCESSIBILITY_RESULT,
  '/v1/inspect/analyze/code_001': CODE_ANALYSIS_RESULT
};

async function run(
  routes: Record<string, Route>,
  timeoutMs: number,
  requestedChecks?: ReadonlySet<'link_validation' | 'image_validation' | 'accessibility' | 'code_analysis'>
) {
  const { deps, requests } = fakeDeps(routes);
  const poll = await pollPreviewQa({ testId: 'preview_test_001', timeoutMs, requestedChecks }, deps);
  const output = buildPreviewQaOutput({
    testId: 'preview_test_001',
    render: poll.render,
    refs: poll.refs,
    fetches: poll.fetches,
    timedOut: poll.timedOut
  });
  return { output, requests };
}

test('complete render fetches every referenced result', async () => {
  const { output, requests } = await run({ [STATUS_PATH]: RENDER_COMPLETE, ...RESULT_ROUTES }, 30_000);
  assert.equal(output.status, 'complete');
  assert.equal(output.timed_out, false);
  assert.equal(output.checks.link_validation.status, 'complete');
  assert.equal(output.checks.code_analysis.status, 'complete');
  assert.equal(output.issue_counts.total, 6);
  assert.ok(requests.includes('GET /v1/inspect/analyze/code_001'));
});

test('polls while a CHECK is still processing, then settles to complete', async () => {
  let analyzeCalls = 0;
  const { output, requests } = await run(
    {
      // Render is done immediately; the code-analysis CHECK lags, so polling is
      // driven by the check, not the render.
      [STATUS_PATH]: RENDER_COMPLETE,
      '/v1/inspect/links/link_001': LINK_RESULT,
      '/v1/inspect/images/image_001': IMAGE_RESULT,
      '/v1/inspect/accessibility/access_001': ACCESSIBILITY_RESULT,
      '/v1/inspect/analyze/code_001': () => {
        analyzeCalls += 1;
        return analyzeCalls >= 3 ? CODE_ANALYSIS_RESULT : CODE_ANALYSIS_PROCESSING;
      }
    },
    60_000
  );
  assert.equal(output.status, 'complete');
  assert.equal(output.timed_out, false);
  assert.equal(output.checks.code_analysis.status, 'complete');
  assert.ok(requests.filter((r) => r === `GET ${STATUS_PATH}`).length >= 3);
});

test('a slow render client does NOT block; returns with render_incomplete', async () => {
  const { output, requests } = await run({ [STATUS_PATH]: RENDER_STRAGGLER, ...RESULT_ROUTES }, 30_000);
  assert.equal(output.timed_out, false);
  assert.equal(output.checks.link_validation.status, 'complete');
  assert.equal(output.summary.processing, 1);
  assert.ok(output.data_gaps.some((g) => g.code === 'render_incomplete'));
  assert.equal(requests.filter((r) => r === `GET ${STATUS_PATH}`).length, 1);
});

test('times out when a CHECK never settles (render is irrelevant)', async () => {
  const { output } = await run(
    {
      [STATUS_PATH]: RENDER_COMPLETE,
      '/v1/inspect/links/link_001': LINK_RESULT,
      '/v1/inspect/images/image_001': IMAGE_RESULT,
      '/v1/inspect/accessibility/access_001': ACCESSIBILITY_RESULT,
      '/v1/inspect/analyze/code_001': CODE_ANALYSIS_PROCESSING
    },
    10_000
  );
  assert.equal(output.timed_out, true);
  assert.equal(output.checks.code_analysis.status, 'processing');
  assert.equal(output.checks.link_validation.status, 'complete');
  assert.ok(output.data_gaps.some((g) => g.code === 'workflow_timed_out'));
});

test('unexpected 404 on a result endpoint marks the check unavailable', async () => {
  const { output } = await run(
    { [STATUS_PATH]: RENDER_CHECK_LIFECYCLE, '/v1/inspect/links/link_001': LINK_RESULT },
    30_000
  );
  assert.equal(output.checks.link_validation.status, 'complete');
  assert.equal(output.checks.image_validation.status, 'job_failed');
  assert.equal(output.checks.accessibility.status, 'not_requested');
  assert.equal(output.checks.code_analysis.status, 'unavailable');
  assert.ok(output.data_gaps.some((g) => g.code === 'result_endpoint_unavailable'));
});

test('an absent requested check remains processing until the deadline', async () => {
  const renderWithoutLinkReference = {
    completed: ['gmail_chrome'],
    processing: [],
    bounced: [],
    content_checking: {
      image_validation: null,
      accessibility: null,
      code_analysis: null
    }
  };

  const { output, requests } = await run(
    { [STATUS_PATH]: renderWithoutLinkReference },
    0,
    new Set(['link_validation'])
  );

  assert.equal(output.timed_out, true);
  assert.equal(output.checks.link_validation.status, 'processing');
  assert.ok(output.data_gaps.some((gap) => gap.code === 'check_reference_missing'));
  assert.ok(output.data_gaps.some((gap) => gap.code === 'workflow_timed_out'));
  assert.equal(requests.filter((request) => request === `GET ${STATUS_PATH}`).length, 1);
});

test('a non-404 detail failure remains a runtime error', async () => {
  const error = new CliError('Mailgun API returned 500', 1, 500);
  const { deps } = fakeDeps({
    [STATUS_PATH]: RENDER_COMPLETE,
    '/v1/inspect/links/link_001': () => {
      throw error;
    },
    '/v1/inspect/images/image_001': IMAGE_RESULT,
    '/v1/inspect/accessibility/access_001': ACCESSIBILITY_RESULT,
    '/v1/inspect/analyze/code_001': CODE_ANALYSIS_RESULT
  });

  await assert.rejects(
    pollPreviewQa({ testId: 'preview_test_001', timeoutMs: 30_000 }, deps),
    /Mailgun API returned 500/
  );
});
