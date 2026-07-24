import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, runCli, type RecordedRequest } from './mock-server.js';
import { PREVIEW_LIST, PREVIEW_LIST_EMPTY, PREVIEW_403 } from '../fixtures/inspect.js';
import {
  CREATE_ALL_CHECKS,
  RENDER_COMPLETE,
  RENDER_CHECK_LIFECYCLE,
  RENDER_PROCESSING,
  LINK_RESULT,
  IMAGE_RESULT,
  ACCESSIBILITY_RESULT,
  CODE_ANALYSIS_RESULT,
  CODE_ANALYSIS_PROCESSING,
  CLIENT_RESULT,
  CLIENTS_CATALOG
} from '../fixtures/email-preview-qa-contract.js';

const STATUS_PATH = '/v2/preview/tests/preview_test_001';

// A unique token embedded in the HTML artifact; dry-run output must never echo it.
const HTML_SECRET = 'SECRET_HTML_MARKER_9f8a';
const SAMPLE_HTML = `<html><body><h1>Hi</h1><p>${HTML_SECRET}</p></body></html>`;

function withHtmlFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'preview-run-'));
  const path = join(dir, 'email.html');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Routes that resolve the four referenced structured-check results for a
// complete render (ids come from CHECK_REFS_ALL inside RENDER_COMPLETE).
const RESULT_ROUTES = [
  { method: 'GET', path: '/v1/inspect/links/link_001', json: LINK_RESULT },
  { method: 'GET', path: '/v1/inspect/images/image_001', json: IMAGE_RESULT },
  { method: 'GET', path: '/v1/inspect/accessibility/access_001', json: ACCESSIBILITY_RESULT },
  { method: 'GET', path: '/v1/inspect/analyze/code_001', json: CODE_ANALYSIS_RESULT }
];

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

test('preview result (complete) summarizes QA counts and references', async () => {
  const server = await startMockServer([
    { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
    ...RESULT_ROUTES
  ]);
  try {
    const result = await runCli(['preview', 'result', 'preview_test_001', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, 'complete');
    assert.equal(json.timed_out, false);
    assert.equal(json.summary.completed, 3);
    assert.equal(json.checks.link_validation.failures, 2);
    assert.equal(json.checks.code_analysis.status, 'complete');
    assert.equal(json.checks.code_analysis.count, 2);
    assert.equal(json.issue_counts.total, 6);
    assert.ok(!json.data_gaps.some((g: { code: string }) => g.code === 'code_analysis_count_formula_unsupported'));
    assert.equal(server.requests[0]!.path, STATUS_PATH);
  } finally {
    await server.close();
  }
});

test('preview result --timeout 0 times out on a lagging CHECK (not the render)', async () => {
  // Render is complete and link/image/a11y resolve, but the code-analysis check
  // is still Processing, so the workflow times out on the check.
  const server = await startMockServer([
    { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
    { method: 'GET', path: '/v1/inspect/links/link_001', json: LINK_RESULT },
    { method: 'GET', path: '/v1/inspect/images/image_001', json: IMAGE_RESULT },
    { method: 'GET', path: '/v1/inspect/accessibility/access_001', json: ACCESSIBILITY_RESULT },
    { method: 'GET', path: '/v1/inspect/analyze/code_001', json: CODE_ANALYSIS_PROCESSING }
  ]);
  try {
    const result = await runCli(['preview', 'result', 'preview_test_001', '--timeout', '0', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.timed_out, true);
    assert.equal(json.checks.code_analysis.status, 'processing');
    assert.equal(json.checks.link_validation.status, 'complete');
    assert.ok(json.data_gaps.some((g: { code: string }) => g.code === 'workflow_timed_out'));
  } finally {
    await server.close();
  }
});

test('preview result accepts a positional test id', async () => {
  const server = await startMockServer([{ method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE }, ...RESULT_ROUTES]);
  try {
    const result = await runCli(['preview', 'result', 'preview_test_001', '--json'], { MAILGUN_API_KEY: 'k' }, server.baseUrl);
    assert.equal(result.code, 0);
    assert.equal(server.requests[0]!.path, STATUS_PATH);
  } finally {
    await server.close();
  }
});

test('preview issues explains accessibility findings from a test id', async () => {
  const server = await startMockServer([
    { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
    { method: 'GET', path: '/v1/inspect/accessibility/access_001', json: ACCESSIBILITY_RESULT }
  ]);
  try {
    const result = await runCli(
      ['preview', 'issues', 'preview_test_001', '--check', 'accessibility', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.test_id, 'preview_test_001');
    assert.equal(json.check, 'accessibility');
    assert.equal(json.result_id, 'access_001');
    assert.deepEqual(json.totals, { confirmed: 3, needs_review: 1 });
    assert.equal(json.issues.length, 4);
    assert.deepEqual(json.issues[0], {
      kind: 'failure',
      rule: 'Color Contrast',
      impact: 'serious',
      description: 'Text has insufficient contrast.',
      standards: ['WCAG 2AA'],
      line: 20,
      column: null,
      target: ['h1'],
      snippet: '<h1 style="color:#fff2f0">',
      url: null
    });
    assert.deepEqual(server.requests.map((request) => request.path), [
      STATUS_PATH,
      '/v1/inspect/accessibility/access_001'
    ]);
  } finally {
    await server.close();
  }
});

test('preview issues explains link failures without including passing checks', async () => {
  const server = await startMockServer([
    { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
    { method: 'GET', path: '/v1/inspect/links/link_001', json: LINK_RESULT }
  ]);
  try {
    const result = await runCli(
      ['preview', 'issues', 'preview_test_001', '--check', 'link_validation', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.totals, { confirmed: 2, needs_review: 0 });
    assert.equal(json.issues.length, 2);
    assert.deepEqual(json.issues[0], {
      kind: 'failure',
      rule: 'Broken Link',
      impact: 'critical',
      description: 'Link returned 404.',
      standards: [],
      line: 20,
      column: 6,
      target: [],
      snippet: null,
      url: 'https://example.com/broken'
    });
  } finally {
    await server.close();
  }
});

test('preview issues shows failed link URLs in human output', async () => {
  const server = await startMockServer([
    { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
    { method: 'GET', path: '/v1/inspect/links/link_001', json: LINK_RESULT }
  ]);
  try {
    const result = await runCli(
      ['preview', 'issues', 'preview_test_001', '--check', 'link_validation'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /https:\/\/example\.com\/broken/);
    assert.match(result.stdout, /line 20 · column 6/);
    assert.doesNotMatch(result.stdout, /https:\/\/example\.com\/ok/);
  } finally {
    await server.close();
  }
});

test('preview issues distinguishes failed checks from unavailable results', async () => {
  const server = await startMockServer([{ method: 'GET', path: STATUS_PATH, json: RENDER_CHECK_LIFECYCLE }]);
  try {
    const result = await runCli(
      ['preview', 'issues', 'preview_test_001', '--check', 'image_validation'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /image_validation check failed/);
    assert.doesNotMatch(result.stderr, /result is not available yet/);
    assert.deepEqual(server.requests.map((request) => request.path), [STATUS_PATH]);
  } finally {
    await server.close();
  }
});

test('preview render downloads one selected client image without printing its signed URL', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const server = await startMockServer([
    {
      method: 'GET',
      path: '/v2/preview/tests/preview_test_001/results/gmail_chrome',
      json: (request: RecordedRequest) => ({
        ...CLIENT_RESULT,
        gmail_chrome: {
          ...CLIENT_RESULT.gmail_chrome,
          screenshots: { full: `http://${request.headers.host}/signed/full.png?token=secret` }
        }
      })
    },
    {
      method: 'GET',
      path: '/signed/full.png',
      body: png,
      headers: { 'Content-Type': 'image/png' }
    }
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'preview-render-'));
  const outputPath = join(dir, 'gmail.png');
  try {
    const result = await runCli(
      [
        'preview',
        'render',
        'preview_test_001',
        'gmail_chrome',
        '--variant',
        'full',
        '--output',
        outputPath,
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.test_id, 'preview_test_001');
    assert.equal(json.client_id, 'gmail_chrome');
    assert.equal(json.display_name, 'Gmail (Chrome)');
    assert.deepEqual(json.available_variants, ['full', 'full_thumbnail', 'thumbnail']);
    assert.equal(json.selected_variant, 'full');
    assert.equal(json.output_path, outputPath);
    assert.equal(json.bytes, png.length);
    assert.equal(result.stdout.includes('token=secret'), false);
    assert.deepEqual(readFileSync(outputPath), png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('preview render with --output chooses the API default screenshot without guessing keys', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const server = await startMockServer([
    {
      method: 'GET',
      path: '/v2/preview/tests/preview_test_001/results/gmail_chrome',
      json: (request: RecordedRequest) => ({
        ...CLIENT_RESULT,
        gmail_chrome: {
          ...CLIENT_RESULT.gmail_chrome,
          screenshots: {
            default: `http://${request.headers.host}/signed/default.png?token=secret`,
            horizontal: `http://${request.headers.host}/signed/horizontal.png?token=secret`
          }
        }
      })
    },
    {
      method: 'GET',
      path: '/signed/default.png',
      body: png,
      headers: { 'Content-Type': 'image/png' }
    }
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'preview-render-default-'));
  const outputPath = join(dir, 'gmail.png');
  try {
    const result = await runCli(
      [
        'preview',
        'render',
        'preview_test_001',
        'gmail_chrome',
        '--output',
        outputPath,
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.selected_variant, 'default');
    assert.equal(json.output_path, outputPath);
    assert.equal(result.stdout.includes('token=secret'), false);
    assert.deepEqual(readFileSync(outputPath), png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('preview render retries a temporarily early screenshot asset without another preview request', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let assetRequests = 0;
  const server = await startMockServer([
    {
      method: 'GET',
      path: '/v2/preview/tests/preview_test_001/results/gmail_chrome',
      json: (request: RecordedRequest) => ({
        gmail_chrome: {
          ...CLIENT_RESULT.gmail_chrome,
          screenshots: {
            default: `http://${request.headers.host}/signed/default.png?token=secret`
          }
        }
      })
    },
    {
      method: 'GET',
      path: '/signed/default.png',
      status: () => {
        assetRequests += 1;
        return assetRequests === 1 ? 425 : 200;
      },
      body: png,
      headers: { 'Content-Type': 'image/png', 'Retry-After': '0' }
    }
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'preview-render-early-'));
  const outputPath = join(dir, 'gmail.png');
  try {
    const result = await runCli(
      [
        'preview',
        'render',
        'preview_test_001',
        'gmail_chrome',
        '--output',
        outputPath,
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(assetRequests, 2);
    assert.deepEqual(server.requests.map((request) => request.path), [
      '/v2/preview/tests/preview_test_001/results/gmail_chrome',
      '/signed/default.png',
      '/signed/default.png'
    ]);
    assert.equal(result.stdout.includes('token=secret'), false);
    assert.deepEqual(readFileSync(outputPath), png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('preview result rejects a non-numeric --timeout (exit 2)', async () => {
  const result = await runCli(['preview', 'result', 'preview_test_001', '--timeout', 'soon', '--json'], { MAILGUN_API_KEY: 'k' });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--timeout must be a non-negative integer/);
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

// --- preview run (write) ---

const CREATE_ROUTES = [
  { method: 'POST', path: '/v2/preview/tests', json: CREATE_ALL_CHECKS },
  { method: 'GET', path: STATUS_PATH, json: RENDER_COMPLETE },
  ...RESULT_ROUTES
];

test('preview run --dry-run makes zero network calls, needs no api key, and never prints HTML', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      ['preview', 'run', '--subject', 'June', '--html', file.path, '--dry-run', '--json'],
      {},
      server.baseUrl
    );
    assert.equal(result.code, 0);
    assert.equal(server.requests.length, 0, 'dry run must not touch the network');
    const json = JSON.parse(result.stdout);
    assert.equal(json.dry_run, true);
    assert.equal(json.action, 'run_email_preview_qa');
    assert.equal(json.will_consume_quota, true);
    assert.equal(json.uses_mailgun_default_clients, true);
    assert.deepEqual(json.content_checks, [
      'link_validation',
      'image_validation',
      'accessibility',
      'code_analysis'
    ]);
    assert.deepEqual(json.source.type, 'html');
    assert.equal(json.source.path, file.path);
    assert.equal(json.source.bytes, Buffer.byteLength(SAMPLE_HTML, 'utf8'));
    assert.match(json.source.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!result.stdout.includes(HTML_SECRET), 'dry run must never print HTML content');
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run human dry-run warns about quota without repeating no-send messaging', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--dry-run'
    ]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /consume preview quota/i);
    assert.doesNotMatch(result.stdout, /send email/i);
  } finally {
    file.cleanup();
  }
});

test('preview run --yes issues exactly one POST then polls to a complete summary', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      ['preview', 'run', '--subject', 'June', '--html', file.path, '--yes', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 0);
    const posts = server.requests.filter((r) => r.method === 'POST' && r.path === '/v2/preview/tests');
    assert.equal(posts.length, 1, 'exactly one create POST');
    const body = JSON.parse(posts[0]!.body);
    assert.equal(body.subject, 'June');
    assert.deepEqual(body.content_checking, {
      link_validation: true,
      image_validation: true,
      accessibility: true,
      code_analysis: true
    });
    assert.equal(body.clients, undefined);
    const json = JSON.parse(result.stdout);
    assert.equal(json.test_id, 'preview_test_001');
    assert.equal(json.status, 'complete');
    assert.equal(json.issue_counts.total, 6);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run preserves an explicit no-check selection when status omits check nodes', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer([
    { method: 'POST', path: '/v2/preview/tests', json: { id: 'preview_test_none', warnings: [] } },
    {
      method: 'GET',
      path: '/v2/preview/tests/preview_test_none',
      json: { completed: ['gmail_chrome'], processing: [], bounced: [], content_checking: {} }
    }
  ]);
  try {
    const result = await runCli(
      [
        'preview',
        'run',
        '--subject',
        'June',
        '--html',
        file.path,
        '--content-checks',
        'none',
        '--timeout',
        '0',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.timed_out, false);
    assert.deepEqual(
      Object.values(output.checks).map((check) => (check as { status: string }).status),
      ['not_requested', 'not_requested', 'not_requested', 'not_requested']
    );
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run reports an explicitly requested client missing from render state', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      [
        'preview',
        'run',
        '--subject',
        'June',
        '--html',
        file.path,
        '--clients',
        'gmail_chrome,missing_client',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.data_gaps.some((gap: { code: string }) => gap.code === 'requested_client_missing'));
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run treats a create 5xx as non-retryable and keeps reference_id as correlation only', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer([
    {
      method: 'POST',
      path: '/v2/preview/tests',
      status: 500,
      json: { message: 'Internal server error' }
    }
  ]);
  try {
    const result = await runCli(
      [
        'preview',
        'run',
        '--subject',
        'June',
        '--html',
        file.path,
        '--reference-id',
        'build-123',
        '--yes',
        '--json'
      ],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );

    assert.equal(result.code, 1);
    assert.equal(server.requests.filter((request) => request.method === 'POST').length, 1);
    assert.match(result.stderr, /no second create was attempted/i);
    assert.match(result.stderr, /correlation only/i);
    assert.doesNotMatch(result.stderr, /using reference_id/i);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run rejects both --dry-run and --yes (exit 2, before network)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  const server = await startMockServer(CREATE_ROUTES);
  try {
    const result = await runCli(
      ['preview', 'run', '--subject', 'June', '--html', file.path, '--dry-run', '--yes', '--json'],
      { MAILGUN_API_KEY: 'k' },
      server.baseUrl
    );
    assert.equal(result.code, 2);
    assert.equal(server.requests.length, 0);
    assert.match(result.stderr, /cannot be combined/);
  } finally {
    await server.close();
    file.cleanup();
  }
});

test('preview run with neither --dry-run nor --yes exits 2', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(['preview', 'run', '--subject', 'June', '--html', file.path, '--json'], {
      MAILGUN_API_KEY: 'k'
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--dry-run to preview .* or --yes to execute/);
  } finally {
    file.cleanup();
  }
});

test('preview run rejects a missing --html file before any network call (exit 2)', async () => {
  const result = await runCli(
    ['preview', 'run', '--subject', 'June', '--html', '/no/such/file.html', '--yes', '--json'],
    { MAILGUN_API_KEY: 'k' }
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /could not read --html file/);
});

test('preview run rejects an oversized --html file (exit 2)', async () => {
  const file = withHtmlFile('x'.repeat(5 * 1024 * 1024 + 1));
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--dry-run',
      '--json'
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /over the 5242880-byte \(5 MiB\) Inspect limit/);
  } finally {
    file.cleanup();
  }
});

test('preview run accepts HTML at the 5 MiB limit', async () => {
  const html = 'x'.repeat(5 * 1024 * 1024);
  const file = withHtmlFile(html);
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--dry-run',
      '--json'
    ]);
    assert.equal(result.code, 0);
  } finally {
    file.cleanup();
  }
});

test('preview run rejects a blank --subject (exit 2)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      ['preview', 'run', '--subject', '   ', '--html', file.path, '--dry-run', '--json'],
      { MAILGUN_API_KEY: 'k' }
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--subject is required/);
  } finally {
    file.cleanup();
  }
});

test('preview run rejects an unknown --content-checks name (exit 2)', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli(
      ['preview', 'run', '--subject', 'June', '--html', file.path, '--content-checks', 'bogus', '--dry-run', '--json'],
      { MAILGUN_API_KEY: 'k' }
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown check 'bogus'/);
  } finally {
    file.cleanup();
  }
});

test('preview run rejects blank entries in an explicit content-check list', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--content-checks',
      'link_validation,,code_analysis',
      '--dry-run',
      '--json'
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /blank check name/);
  } finally {
    file.cleanup();
  }
});

test('preview run rejects blank entries in an explicit client list', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--clients',
      'gmail_chrome,,outlook_win',
      '--dry-run',
      '--json'
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /blank client id/i);
  } finally {
    file.cleanup();
  }
});

test('preview run requires exact API content-check names', async () => {
  const file = withHtmlFile(SAMPLE_HTML);
  try {
    const result = await runCli([
      'preview',
      'run',
      '--subject',
      'June',
      '--html',
      file.path,
      '--content-checks',
      'LINK_VALIDATION',
      '--dry-run',
      '--json'
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown check 'LINK_VALIDATION'/);
  } finally {
    file.cleanup();
  }
});
