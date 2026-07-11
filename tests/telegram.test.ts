// Tests for the Telegram helpers' retry policy, with fetch mocked so nothing
// leaves the machine. Fake credentials are set before the module loads; the
// .env loader never overrides an already-set environment.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "12345";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const { sendMessage } = await import("../src/telegram.js");

type FakeResponse = { status: number; json: () => Promise<unknown> };

const realFetch = globalThis.fetch;
let requests: { url: string; body: unknown }[] = [];

function mockFetch(...outcomes: (FakeResponse | Error)[]): void {
  requests = [];
  let call = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body });
    const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof fetch;
}

function reply(status: number, body: unknown): FakeResponse {
  return { status, json: async () => body };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("sendMessage posts to the bot API and succeeds first try", async () => {
  mockFetch(reply(200, { ok: true, result: {} }));
  await sendMessage("hello");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.telegram.org/bottest-token/sendMessage");
  const params = requests[0].body as URLSearchParams;
  assert.equal(params.get("chat_id"), "12345");
  assert.equal(params.get("text"), "hello");
});

test("retries once on a 5xx, then succeeds", async () => {
  mockFetch(reply(502, { ok: false, description: "bad gateway" }), reply(200, { ok: true, result: {} }));
  await sendMessage("hello");
  assert.equal(requests.length, 2);
});

test("retries once on a network error, then succeeds", async () => {
  mockFetch(new TypeError("fetch failed"), reply(200, { ok: true, result: {} }));
  await sendMessage("hello");
  assert.equal(requests.length, 2);
});

test("does NOT retry on a 4xx — the request itself is wrong", async () => {
  mockFetch(reply(400, { ok: false, description: "chat not found" }), reply(200, { ok: true, result: {} }));
  await assert.rejects(sendMessage("hello"), /chat not found/);
  assert.equal(requests.length, 1, "a 400 must never be retried");
});

test("never sends more than twice, even for persistent 5xx", async () => {
  mockFetch(reply(500, { ok: false, description: "server error" }));
  await assert.rejects(sendMessage("hello"), /server error/);
  assert.equal(requests.length, 2, "at-most-twice delivery policy");
});
