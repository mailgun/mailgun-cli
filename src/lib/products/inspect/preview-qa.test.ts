import test from 'node:test';
import assert from 'node:assert/strict';
import { pollPreviewQa, buildPreviewQaOutput, type PollDeps } from './preview-qa.js';
import { CliError } from '../../cli/output.js';
import {
  RENDER_COMPLETE,
  RENDER_PROCESSING,
  RENDER_CHECK_LIFECYCLE,
  LINK_RESULT,
  IMAGE_RESULT,
  ACCESSIBILITY_RESULT,
  CODE_ANALYSIS_RESULT
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
  '/v1/inspect/analyze/preview_test_001': CODE_ANALYSIS_RESULT
};

async function run(routes: Record<string, Route>, timeoutMs: number) {
  const { deps, requests } = fakeDeps(routes);
  const poll = await pollPreviewQa({ testId: 'preview_test_001', timeoutMs }, deps);
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
  assert.equal(output.issue_counts.total, 5);
  assert.ok(requests.includes('GET /v1/inspect/analyze/preview_test_001'));
});

test('polls while processing then settles to complete', async () => {
  let calls = 0;
  const { output, requests } = await run(
    {
      [STATUS_PATH]: () => {
        calls += 1;
        return calls >= 3 ? RENDER_COMPLETE : RENDER_PROCESSING;
      },
      ...RESULT_ROUTES
    },
    60_000
  );
  assert.equal(output.status, 'complete');
  assert.equal(output.timed_out, false);
  assert.ok(requests.filter((r) => r === `GET ${STATUS_PATH}`).length >= 3);
});

test('times out while processing and does not fetch results', async () => {
  const { output, requests } = await run({ [STATUS_PATH]: RENDER_PROCESSING, ...RESULT_ROUTES }, 10_000);
  assert.equal(output.status, 'processing');
  assert.equal(output.timed_out, true);
  assert.equal(output.checks.link_validation.status, 'processing');
  assert.ok(output.data_gaps.some((g) => g.code === 'workflow_timed_out'));
  assert.ok(!requests.some((r) => r.startsWith('GET /v1/inspect/')));
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
