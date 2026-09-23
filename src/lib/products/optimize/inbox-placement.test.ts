import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInboxCreateRequest,
  extractCreatedMailingList,
  extractCreatedResultId,
  normalizeInboxList,
  normalizeInboxResult,
  pollInboxPlacementResult,
  runInboxPlacementTest,
  InboxRunError
} from './inbox-placement.js';
import {
  INBOX_CREATE_RESPONSE,
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

test('buildInboxCreateRequest emits html content and optional provider filter', () => {
  const body = buildInboxCreateRequest({
    from: 'news@example.com',
    subject: 'June campaign',
    content: { kind: 'html', value: '<p>hi</p>' },
    providers: ['gmail.com', 'yahoo.com'],
    seedList: 'seedlist_1',
    maxSeedsPerProvider: 5
  });
  assert.deepEqual(body, {
    from: 'news@example.com',
    subject: 'June campaign',
    html: '<p>hi</p>',
    provider_filter: ['gmail.com', 'yahoo.com'],
    seed_list: 'seedlist_1',
    max_seeds_per_provider: 5
  });
});

test('buildInboxCreateRequest supports template_name content', () => {
  const body = buildInboxCreateRequest({
    from: 'news@example.com',
    subject: 'June campaign',
    content: { kind: 'template_name', value: 'welcome' }
  });
  assert.deepEqual(body, {
    from: 'news@example.com',
    subject: 'June campaign',
    template_name: 'welcome'
  });
});

test('extractCreatedResultId reads result_id from create response', () => {
  assert.equal(extractCreatedResultId(INBOX_CREATE_RESPONSE), 'result_123');
  assert.equal(extractCreatedMailingList(INBOX_CREATE_RESPONSE), 'ibp-seed@example.com');
  assert.equal(extractCreatedResultId({}), null);
});

test('pollInboxPlacementResult stops when status leaves processing', async () => {
  const calls: string[] = [];
  const poll = await pollInboxPlacementResult(
    { resultId: 'result_123', timeoutMs: 30_000, intervalMs: 1 },
    {
      request: async (_method, path) => {
        calls.push(path);
        return calls.length === 1 ? INBOX_RESULT_PROCESSING : INBOX_RESULT_COMPLETE;
      },
      now: (() => {
        let t = 0;
        return () => {
          t += 1;
          return t;
        };
      })(),
      sleep: async () => undefined
    }
  );
  assert.equal(poll.timedOut, false);
  assert.equal(calls.length, 2);
  assert.equal(normalizeInboxResult('result_123', poll.response).status, 'complete');
});

test('runInboxPlacementTest creates once then returns a complete summary', async () => {
  const methods: string[] = [];
  let createdId: string | undefined;
  const output = await runInboxPlacementTest({
    apiKey: 'k',
    baseUrl: 'http://example.test',
    create: {
      from: 'news@example.com',
      subject: 'June campaign',
      content: { kind: 'html', value: '<p>hi</p>' }
    },
    timeoutSeconds: 30,
    onCreated: (resultId) => {
      createdId = resultId;
    },
    deps: {
      request: async (method, path, body) => {
        methods.push(`${method} ${path}`);
        if (method === 'POST') {
          assert.equal(path, '/v4/inbox/tests');
          assert.equal((body as { subject: string }).subject, 'June campaign');
          return INBOX_CREATE_RESPONSE;
        }
        return INBOX_RESULT_COMPLETE;
      },
      now: () => 0,
      sleep: async () => undefined
    }
  });
  assert.deepEqual(methods, ['POST /v4/inbox/tests', 'GET /v4/inbox/results/result_123']);
  assert.equal(createdId, 'result_123');
  assert.equal(output.result_id, 'result_123');
  assert.equal(output.timed_out, false);
  assert.equal(output.mailing_list, 'ibp-seed@example.com');
  assert.equal(output.placement.inbox_rate, 0.857);
});

test('runInboxPlacementTest treats create 5xx as create_uncertain and never retries', async () => {
  let posts = 0;
  await assert.rejects(
    () =>
      runInboxPlacementTest({
        apiKey: 'k',
        baseUrl: 'http://example.test',
        create: {
          from: 'news@example.com',
          subject: 'June campaign',
          content: { kind: 'html', value: '<p>hi</p>' }
        },
        deps: {
          request: async (method) => {
            if (method === 'POST') {
              posts += 1;
              const err = new Error('upstream 500') as Error & { statusCode: number };
              err.statusCode = 500;
              throw err;
            }
            throw new Error('unexpected GET');
          },
          now: () => 0,
          sleep: async () => undefined
        }
      }),
    (error: unknown) => {
      assert.ok(error instanceof InboxRunError);
      assert.equal(error.kind, 'create_uncertain');
      assert.equal(error.statusCode, 500);
      return true;
    }
  );
  assert.equal(posts, 1);
});
