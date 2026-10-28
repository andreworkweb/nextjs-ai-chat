import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, mock, test } from "node:test";
import { rerankChunks } from "../src/lib/rag/rerank-chunks.ts";

const names = ["COHERE_API_KEY", "OPENROUTER_API_KEY", "RAG_RERANK_ENABLED", "RAG_RERANK_MODEL", "RAG_RERANK_TOP_N", "RAG_RERANK_TIMEOUT_MS"];
const originalEnvironment = new Map(names.map((name) => [name, process.env[name]]));
let defaultFetch;
beforeEach(() => {
  for (const name of names) delete process.env[name];
  process.env.OPENROUTER_API_KEY = "unrelated-openrouter-key";
  defaultFetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected live call"); });
});
afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function chunks(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    text: `Original C++ v2.5 passage ${index}.\n\nhttps://example.com/a?q=1 — Привіт 🙂`,
    documentId: `document-${index}`, sourceName: `folder/guide-${index}.pdf`, chunkId: `original-chunk-${index}`,
    page: index + 1, pageNumber: index + 1, chunkIndex: index,
    score: 0.95 - index / 100, extraMetadata: { section: `section-${index}` },
  }));
}

function enable() {
  process.env.RAG_RERANK_ENABLED = "true";
  process.env.COHERE_API_KEY = "fake-cohere-key";
}

function transport(responder) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      return responder ? responder(body, init) : Response.json({ results: Array.from({ length: body.top_n }, (_, index) => ({
        index: body.documents.length - 1 - index, relevance_score: 0.95 - index / 10,
      })) });
    },
  };
}

function assertOriginal(result, original) {
  assert.deepEqual(result, original);
  assert.ok(result.every((chunk) => !Object.hasOwn(chunk, "rerankScore")));
}

test("reranking is disabled by default and keeps all vector results in their original order", async () => {
  const original = chunks();
  process.env.COHERE_API_KEY = "fake-cohere-key";
  assertOriginal(await rerankChunks("Question", original), original);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("explicit disable overrides enabled configuration without truncating to the top five", async () => {
  enable();
  const original = chunks(10);
  assertOriginal(await rerankChunks("Question", original, { enabled: false, topN: 1 }), original);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("the Cohere v2 request uses the original question and text with server-only credentials", async () => {
  enable();
  const original = chunks();
  const upstream = transport();
  const result = await rerankChunks(" Original question? ", original, { fetch: upstream.fetch });
  assert.equal(upstream.calls.length, 1);
  const { url, init, body } = upstream.calls[0];
  assert.equal(url, "https://api.cohere.com/v2/rerank");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer fake-cohere-key");
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.deepEqual(body, {
    model: "rerank-v5.0-fast", query: " Original question? ", documents: original.map((chunk) => chunk.text), top_n: 5,
  });
  assert.ok(!init.body.includes("fake-cohere-key"));
  assert.equal(result.length, 5);
  assert.deepEqual(result.map((chunk) => chunk.chunkId), [7, 6, 5, 4, 3].map((index) => original[index].chunkId));
});

test("real relevance scores determine sorting while all source metadata and vector scores remain intact", async () => {
  enable();
  const original = Object.freeze(chunks().map((chunk) => Object.freeze(chunk)));
  const snapshot = structuredClone(original);
  const scores = [[6, 0.4], [0, 0.2], [4, 0.99], [2, 0.8], [7, 0.6]];
  const upstream = transport(() => Response.json({ results: scores.map(([index, relevance_score]) => ({
    index, relevance_score, document: { text: "Provider-modified text must be ignored." },
  })) }));
  const result = await rerankChunks("Question", original, { fetch: upstream.fetch });
  assert.deepEqual(result.map((chunk) => chunk.chunkId), [4, 2, 7, 6, 0].map((index) => original[index].chunkId));
  assert.deepEqual(result.map((chunk) => chunk.rerankScore), [0.99, 0.8, 0.6, 0.4, 0.2]);
  for (const item of result) {
    const { rerankScore, ...metadata } = item;
    assert.equal(typeof rerankScore, "number");
    assert.deepEqual(metadata, original.find((chunk) => chunk.chunkId === item.chunkId));
  }
  assert.deepEqual(original, snapshot);
  assert.ok(original.every((chunk) => !Object.hasOwn(chunk, "rerankScore")));
});

test("equal scores retain vector-search order and valid zero and one scores are preserved", async () => {
  enable();
  const original = chunks(4);
  const upstream = transport(() => Response.json({ results: [
    { index: 3, relevance_score: 0 }, { index: 2, relevance_score: 0.5 },
    { index: 1, relevance_score: 0.5 }, { index: 0, relevance_score: 1 },
  ] }));
  const result = await rerankChunks("Question", original, { fetch: upstream.fetch });
  assert.deepEqual(result.map((chunk) => chunk.chunkId), original.map((chunk) => chunk.chunkId));
  assert.deepEqual(result.map((chunk) => chunk.rerankScore), [1, 0.5, 0.5, 0]);
  assert.equal(upstream.calls[0].body.top_n, 4);
});

test("model and top-N configuration are configurable and explicit server options override defaults", async () => {
  enable();
  process.env.RAG_RERANK_MODEL = "rerank-v3.5";
  process.env.RAG_RERANK_TOP_N = "3";
  const upstream = transport();
  const original = chunks();
  assert.equal((await rerankChunks("Question", original, { fetch: upstream.fetch })).length, 3);
  assert.equal(upstream.calls[0].body.model, "rerank-v3.5");
  process.env.RAG_RERANK_ENABLED = "false";
  assert.equal((await rerankChunks("Question", original, { enabled: true, topN: 2, fetch: upstream.fetch })).length, 2);
  assert.equal(upstream.calls[1].body.top_n, 2);
});

test("empty retrieval returns an empty array without a Cohere request", async () => {
  enable();
  assert.deepEqual(await rerankChunks("Question", []), []);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("missing or invalid Cohere credentials preserve retrieval without using another provider key", async () => {
  process.env.RAG_RERANK_ENABLED = "true";
  const original = chunks();
  assertOriginal(await rerankChunks("Question", original), original);
  for (const key of ["", " ", "invalid\nkey"]) {
    process.env.COHERE_API_KEY = key;
    assertOriginal(await rerankChunks("Question", original), original);
  }
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("invalid optional configuration or excessive candidate counts fall back safely", async () => {
  enable();
  const original = chunks();
  for (const [name, values] of [
    ["RAG_RERANK_MODEL", ["", " ", "bad\nmodel"]], ["RAG_RERANK_TOP_N", ["0", "101", "1.5", "bad"]],
    ["RAG_RERANK_TIMEOUT_MS", ["0", "60001", "bad"]],
  ]) {
    for (const value of values) {
      process.env[name] = value;
      assertOriginal(await rerankChunks("Question", original), original);
    }
    delete process.env[name];
  }
  for (const topN of [0, -1, 1.5, NaN, Infinity, "3", null, 101]) {
    assertOriginal(await rerankChunks("Question", original, { topN }), original);
  }
  const excessive = chunks(1001);
  assertOriginal(await rerankChunks("Question", excessive), excessive);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("HTTP authentication errors, rate limits, and temporary failures retain all original hits", async () => {
  enable();
  const original = chunks();
  for (const status of [400, 401, 403, 404, 422, 429, 498, 500, 503, 504]) {
    let cancelled = false;
    const upstream = transport(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("fake-cohere-key private provider details")); },
      cancel() { cancelled = true; },
    }), { status }));
    assertOriginal(await rerankChunks("Question", original, { fetch: upstream.fetch }), original);
    assert.equal(upstream.calls.length, 1);
    assert.equal(cancelled, true);
  }
});

test("malformed JSON and incomplete responses never invent partial rerank scores", async () => {
  enable();
  const original = chunks();
  for (const invalid of [() => new Response("not-json"), () => Response.json(null),
    () => Response.json({}), () => Response.json({ results: [] }),
    () => Response.json({ results: "invalid" }),
    () => Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }),
  ]) {
    const upstream = transport(invalid);
    assertOriginal(await rerankChunks("Question", original, { fetch: upstream.fetch }), original);
    assert.equal(upstream.calls.length, 1);
  }
});

test("invalid indexes, duplicate results, and invalid numeric scores fall back to original ordering", async () => {
  enable();
  const original = chunks();
  const valid = Array.from({ length: 5 }, (_, index) => ({ index, relevance_score: 0.9 - index / 10 }));
  for (const replacement of [
    { index: -1 }, { index: 8 }, { index: 0.5 }, { index: "0" }, { index: 1 },
    { relevance_score: null }, { relevance_score: "0.5" }, { relevance_score: -0.1 }, { relevance_score: 1.1 },
  ]) {
    const upstream = transport(() => Response.json({ results: [{ ...valid[0], ...replacement }, ...valid.slice(1)] }));
    assertOriginal(await rerankChunks("Question", original, { fetch: upstream.fetch }), original);
  }
  const overflow = transport(() => new Response(JSON.stringify({ results: valid }).replace('"relevance_score":0.9', '"relevance_score":1e999')));
  assertOriginal(await rerankChunks("Question", original, { fetch: overflow.fetch }), original);
});

test("network exceptions cannot leak secrets or document contents into logs or scores", async () => {
  enable();
  const original = chunks();
  const logs = ["log", "warn", "error", "info", "debug"].map((name) => mock.method(console, name, () => {}));
  const upstream = transport(() => { throw new Error("fake-cohere-key private-question private-document"); });
  const result = await rerankChunks("private-question", original, { fetch: upstream.fetch });
  assertOriginal(result, original);
  assert.doesNotMatch(JSON.stringify(result), /fake-cohere-key/);
  assert.ok(logs.every((entry) => entry.mock.callCount() === 0));
});

test("a timed-out Cohere request falls back without breaking retrieval", async () => {
  enable();
  process.env.RAG_RERANK_TIMEOUT_MS = "5";
  const original = chunks();
  const upstream = transport((_body, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("private timeout", "AbortError")), { once: true });
  }));
  assertOriginal(await rerankChunks("Question", original, { fetch: upstream.fetch }), original);
  assert.equal(upstream.calls.length, 1);
});

test("timeout also covers reading the Cohere response body", async () => {
  enable();
  process.env.RAG_RERANK_TIMEOUT_MS = "5";
  const original = chunks();
  const upstream = transport((_body, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
      init.signal.addEventListener("abort", () => controller.error(new DOMException("private timeout", "AbortError")), { once: true });
    },
  })));
  assertOriginal(await rerankChunks("Question", original, { fetch: upstream.fetch }), original);
});

test("completed requests release their timeout instead of aborting successful signals later", async () => {
  enable();
  process.env.RAG_RERANK_TIMEOUT_MS = "5";
  const upstream = transport();
  assert.equal((await rerankChunks("Question", chunks(), { fetch: upstream.fetch })).length, 5);
  await delay(15);
  assert.equal(upstream.calls[0].init.signal.aborted, false);
});

test("caller cancellation is propagated safely and never starts another request", async () => {
  enable();
  const original = chunks();
  const cancelled = new AbortController();
  cancelled.abort(new Error("private reason"));
  await assert.rejects(rerankChunks("Question", original, { signal: cancelled.signal }), (error) => error.name === "AbortError" && !error.message.includes("private reason"));
  assert.equal(defaultFetch.mock.callCount(), 0);
  const active = new AbortController();
  const upstream = transport((_body, init) => {
    const pending = new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("private reason")), { once: true });
    });
    active.abort(new Error("private reason"));
    return pending;
  });
  await assert.rejects(rerankChunks("Question", original, { fetch: upstream.fetch, signal: active.signal }), (error) => error.name === "AbortError" && !error.message.includes("private reason"));
  assert.equal(upstream.calls.length, 1);
});

test("invalid caller inputs are rejected before requesting the reranking model", async () => {
  enable();
  for (const question of [null, undefined, "", " \n", 12]) {
    await assert.rejects(rerankChunks(question, chunks()), TypeError);
  }
  for (const invalid of [null, {}, "invalid", [null], [{ text: "missing metadata" }]]) {
    await assert.rejects(rerankChunks("Question", invalid), TypeError);
  }
  for (const options of [null, [], { enabled: "true" }, { fetch: 1 }, { signal: {} }]) {
    await assert.rejects(rerankChunks("Question", chunks(), options), TypeError);
  }
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("browser execution is rejected before credentials are used", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    await assert.rejects(rerankChunks("Question", chunks()), /Node\.js server/);
    assert.equal(defaultFetch.mock.callCount(), 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});
