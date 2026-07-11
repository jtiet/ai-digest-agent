// Tests for the retry helper. delayMs: 1 keeps backoff out of the test clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withRetry } from "../src/retry.js";

function failNTimes<T>(n: number, result: T) {
  let calls = 0;
  const fn = async (): Promise<T> => {
    calls++;
    if (calls <= n) throw new Error(`boom ${calls}`);
    return result;
  };
  return { fn, calls: () => calls };
}

test("returns immediately on first success", async () => {
  const { fn, calls } = failNTimes(0, "ok");
  assert.equal(await withRetry("t", fn, { delayMs: 1 }), "ok");
  assert.equal(calls(), 1);
});

test("retries through transient failures up to the attempt budget", async () => {
  const { fn, calls } = failNTimes(2, "ok");
  assert.equal(await withRetry("t", fn, { attempts: 3, delayMs: 1 }), "ok");
  assert.equal(calls(), 3);
});

test("throws the last error once attempts are exhausted", async () => {
  const { fn, calls } = failNTimes(5, "never");
  await assert.rejects(withRetry("t", fn, { attempts: 2, delayMs: 1 }), /boom 2/);
  assert.equal(calls(), 2);
});

test("stops immediately when shouldRetry says no", async () => {
  const { fn, calls } = failNTimes(5, "never");
  await assert.rejects(
    withRetry("t", fn, { attempts: 3, delayMs: 1, shouldRetry: () => false }),
    /boom 1/,
  );
  assert.equal(calls(), 1);
});

test("consults shouldRetry with the thrown error", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw Object.assign(new Error("nope"), { retryable: calls < 2 });
  };
  await assert.rejects(
    withRetry("t", fn, {
      attempts: 5,
      delayMs: 1,
      shouldRetry: (err) => (err as { retryable: boolean }).retryable,
    }),
  );
  assert.equal(calls, 2, "retried while retryable, stopped when not");
});
