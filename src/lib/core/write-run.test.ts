import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnce, pollUntil, resolveTimeoutSeconds, type PollDeps } from './write-run.js';

function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

function depsFor(request: PollDeps['request']): PollDeps {
  let current = 0;
  return {
    request,
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    }
  };
}

test('resolveTimeoutSeconds applies the default and rejects invalid values instead of clamping', () => {
  assert.equal(resolveTimeoutSeconds(undefined, 120), 120);
  assert.equal(resolveTimeoutSeconds(600, 120), 600);
  for (const invalid of [-1, 600.1, 601, Number.NaN]) {
    assert.throws(() => resolveTimeoutSeconds(invalid, 120), /integer between 0 and 600/);
  }
});

test('createOnce rethrows definitive 4xx and marks 429, 5xx, and transport failures uncertain', async () => {
  const uncertain = (cause: { statusCode?: number; detail: string }) =>
    Object.assign(new Error('uncertain'), { cause });

  for (const status of [429, 500, 503]) {
    let posts = 0;
    const deps = depsFor(async () => {
      posts += 1;
      throw httpError(status);
    });
    await assert.rejects(createOnce(deps, '/create', {}, uncertain), (error: Error & { cause: unknown }) => {
      assert.equal(error.message, 'uncertain');
      assert.deepEqual(error.cause, { statusCode: status, detail: `status ${status}` });
      return true;
    });
    assert.equal(posts, 1);
  }

  await assert.rejects(createOnce(depsFor(async () => { throw httpError(400); }), '/create', {}, uncertain), /status 400/);
  await assert.rejects(
    createOnce(depsFor(async () => { throw new Error('socket hang up'); }), '/create', {}, uncertain),
    (error: Error & { cause: unknown }) => {
      assert.deepEqual(error.cause, { detail: 'socket hang up' });
      return true;
    }
  );
});

test('pollUntil stops when settled, times out at the deadline, and fetches once for timeout 0', async () => {
  let fetches = 0;
  const deps = depsFor(async () => undefined);
  const fetch = async () => ++fetches;

  const settled = await pollUntil({ timeoutMs: 60_000, intervalMs: 10, fetch, isSettled: (n) => n >= 3 }, deps);
  assert.deepEqual(settled, { state: 3, timedOut: false });

  fetches = 0;
  const timedOut = await pollUntil({ timeoutMs: 25, intervalMs: 10, fetch, isSettled: () => false }, deps);
  assert.deepEqual(timedOut, { state: 3, timedOut: true });

  fetches = 0;
  const once = await pollUntil({ timeoutMs: 0, intervalMs: 0, fetch, isSettled: () => false }, deps);
  assert.deepEqual(once, { state: 1, timedOut: true });
});
