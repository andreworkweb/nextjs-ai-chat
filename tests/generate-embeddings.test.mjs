import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractText } from "../src/lib/rag/extract-text.ts";
import { splitText } from "../src/lib/rag/split-text.ts";
import { EmbeddingGenerationError, generateEmbeddings } from "../src/lib/rag/generate-embeddings.ts";

const environmentNames = [
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "RAG_EMBEDDING_MODEL", "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_BATCH_SIZE", "RAG_EMBEDDING_TIMEOUT_MS", "RAG_EMBEDDING_MAX_RETRIES",
];
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
const fakeKey = "unit-test-key-not-a-real-credential";
let defaultFetch;

beforeEach(() => {
  for (const name of environmentNames) delete process.env[name];
  process.env.OPENROUTER_API_KEY = fakeKey;
  // A forgotten injection must never turn a unit test into a live API call.
  defaultFetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected default fetch"); });
});

afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function chunk(index = 0, overrides = {}) {
  return {
    id: `chunk-${index}`, documentId: "a".repeat(64), sourceName: "guide.pdf",
    pageNumber: 3, chunkIndex: index, text: `Synthetic chunk ${index}.`, ...overrides,
  };
}

function responseFor(input, dimensions = 1024) {
  return Response.json({ data: input.map((_, index) => ({ index, embedding: Array(dimensions).fill(index + 0.25) })) });
}

function transport(responder) {
  const calls = [];
  const waits = [];
  return {
    calls,
    waits,
    options: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        return responder ? responder(body, calls.length, init) : responseFor(body.input);
      },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    },
  };
}

function expectError(code, status) {
  return (error) => {
    assert.ok(error instanceof EmbeddingGenerationError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

function assertRedacted(error, ...secrets) {
  const printable = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of secrets) assert.ok(!printable.includes(secret));
  assert.equal(error.cause, undefined);
}

test("default Liquid model requests are authenticated over HTTPS and return 1024-dimensional vectors", async () => {
  const upstream = transport();
  const original = [chunk(0), chunk(1)];
  const result = await generateEmbeddings(original, upstream.options);
  assert.equal(upstream.calls.length, 1);
  const { url, init, body } = upstream.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${fakeKey}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body, {
    model: "liquid/lfm-2.5-embedding-350m:free",
    input: original.map((entry) => entry.text), encoding_format: "float",
  });
  assert.ok(!init.body.includes(fakeKey));
  assert.deepEqual(result.map(({ embedding, ...metadata }) => {
    assert.equal(embedding.length, 1024);
    assert.ok(embedding.every(Number.isFinite));
    return metadata;
  }), original);
});

test("all chunks are embedded in sequential batches of 16, including the final partial batch", async () => {
  const original = Array.from({ length: 35 }, (_, index) => chunk(index));
  let active = 0;
  let maxActive = 0;
  const upstream = transport(async (body) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    return responseFor(body.input);
  });
  const result = await generateEmbeddings(original, upstream.options);
  assert.deepEqual(upstream.calls.map((call) => call.body.input.length), [16, 16, 3]);
  assert.equal(maxActive, 1);
  assert.equal(result.length, 35);
  assert.deepEqual(result.map((entry) => entry.id), original.map((entry) => entry.id));
  assert.deepEqual(upstream.calls.flatMap((call) => call.body.input), original.map((entry) => entry.text));
});

test("server environment configures model, dimensions, and batch size", async () => {
  process.env.RAG_EMBEDDING_MODEL = "test/embedding-model";
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  process.env.RAG_EMBEDDING_BATCH_SIZE = "2";
  const upstream = transport((body) => responseFor(body.input, 3));
  const result = await generateEmbeddings([chunk(0), chunk(1), chunk(2)], upstream.options);
  assert.deepEqual(upstream.calls.map((call) => call.body.input.length), [2, 1]);
  assert.ok(upstream.calls.every((call) => call.body.model === "test/embedding-model"));
  assert.ok(result.every((entry) => entry.embedding.length === 3));
});

test("response indexes map out-of-order vectors to the correct chunks", async () => {
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  const upstream = transport(() => Response.json({ data: [
    { index: 2, embedding: [3, 3, 3] }, { index: 0, embedding: [1, 1, 1] }, { index: 1, embedding: [2, 2, 2] },
  ] }));
  const result = await generateEmbeddings([chunk(0), chunk(1), chunk(2)], upstream.options);
  assert.deepEqual(result.map((entry) => [entry.id, entry.embedding]), [
    ["chunk-0", [1, 1, 1]], ["chunk-1", [2, 2, 2]], ["chunk-2", [3, 3, 3]],
  ]);
});

test("IDs, citation metadata, text, and additional fields are preserved without input mutation", async () => {
  const original = Object.freeze([Object.freeze(chunk(0, { checksum: "original", text: "Keep text exactly.\n\nSecond paragraph." }))]);
  const snapshot = structuredClone(original);
  const result = await generateEmbeddings(original, transport().options);
  assert.deepEqual(original, snapshot);
  const { embedding, ...metadata } = result[0];
  assert.deepEqual(metadata, original[0]);
  assert.notEqual(result[0], original[0]);
  embedding[0] = 42;
  result[0].text = "Independent output";
  assert.deepEqual(original, snapshot);
});

test("empty arrays return safely without requiring credentials or making API calls", async () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.deepEqual(await generateEmbeddings([]), []);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("the default transport is mockable without changing application code", async () => {
  defaultFetch.mock.mockImplementation(async (_url, init) => responseFor(JSON.parse(init.body).input));
  assert.equal((await generateEmbeddings([chunk()])).length, 1);
  assert.equal(defaultFetch.mock.callCount(), 1);
});

test("invalid dimensions, non-finite numbers, and non-numeric vector values are rejected without retries", async () => {
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  for (const embedding of [[], [1, 2], [1, 2, 3, 4], [1, null, 3], [1, "2", 3], [1, {}, 3], "not-a-vector"]) {
    const upstream = transport(() => Response.json({ data: [{ index: 0, embedding }] }));
    await assert.rejects(generateEmbeddings([chunk()], upstream.options), expectError("INVALID_RESPONSE"));
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.waits, []);
  }
  // JSON numbers can overflow JavaScript's finite numeric range when decoded.
  const overflow = transport(() => new Response('{"data":[{"index":0,"embedding":[0,1e999,0]}]}'));
  await assert.rejects(generateEmbeddings([chunk()], overflow.options), expectError("INVALID_RESPONSE"));
});

test("missing, duplicate, negative, fractional, and out-of-range indexes are rejected", async () => {
  process.env.RAG_EMBEDDING_DIMENSIONS = "1";
  for (const data of [
    [], [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }],
    [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }],
    [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }],
    [{ embedding: [1] }, { index: 1, embedding: [2] }],
    [{ index: "0", embedding: [1] }, { index: 1, embedding: [2] }],
    [{ index: 0, embedding: [1] }, { index: 2, embedding: [2] }],
  ]) {
    const upstream = transport(() => Response.json({ data }));
    await assert.rejects(generateEmbeddings([chunk(0), chunk(1)], upstream.options), expectError("INVALID_RESPONSE"));
    assert.equal(upstream.calls.length, 1);
  }
});

test("malformed JSON and invalid response shapes are safe non-retryable errors", async () => {
  for (const response of [new Response("not-json"), Response.json(null), Response.json({ data: "invalid" }), Response.json({ error: "private provider details" })]) {
    const upstream = transport(() => response);
    await assert.rejects(generateEmbeddings([chunk()], upstream.options), expectError("INVALID_RESPONSE"));
    assert.equal(upstream.calls.length, 1);
  }
});

test("rate limits and temporary provider failures use bounded exponential backoff", async () => {
  const upstream = transport((body, attempt) => attempt < 4
    ? new Response("private error", { status: attempt === 1 ? 429 : 503 }) : responseFor(body.input));
  assert.equal((await generateEmbeddings([chunk()], upstream.options)).length, 1);
  assert.deepEqual(upstream.waits, [500, 1000, 2000]);
  assert.equal(upstream.calls.length, 4);
  assert.ok(upstream.calls.every((call) => call.init.body === upstream.calls[0].init.body));
});

test("network failures exhaust exactly the configured retry budget", async () => {
  const upstream = transport(() => { throw new TypeError("Connection reset with private transport details"); });
  await assert.rejects(generateEmbeddings([chunk()], upstream.options), expectError("NETWORK_ERROR"));
  assert.equal(upstream.calls.length, 4);
  assert.deepEqual(upstream.waits, [500, 1000, 2000]);
});

test("Retry-After seconds and HTTP dates are respected", async () => {
  const now = 1_700_000_000_000;
  mock.method(Date, "now", () => now);
  for (const [header, expectedWait] of [["3", 3000], [new Date(now + 5000).toUTCString(), 5000], ["0.1", 500], ["invalid", 500]]) {
    const upstream = transport((body, attempt) => attempt === 1
      ? new Response("private error", { status: 429, headers: { "Retry-After": header } }) : responseFor(body.input));
    await generateEmbeddings([chunk()], upstream.options);
    assert.deepEqual(upstream.waits, [expectedWait]);
  }
});

test("long Retry-After instructions stop safely instead of retrying too early", async () => {
  const upstream = transport(() => new Response("private error", { status: 429, headers: { "Retry-After": "60" } }));
  await assert.rejects(generateEmbeddings([chunk()], upstream.options), expectError("RATE_LIMITED", 429));
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(upstream.waits, []);
});

test("permanent HTTP errors and invalid credentials are never retried or exposed", async () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422]) {
    const privateText = "private-document-fragment";
    const upstream = transport(() => new Response(`${fakeKey} ${privateText}`, { status }));
    const code = status === 401 || status === 403 ? "AUTHENTICATION_FAILED" : "REQUEST_REJECTED";
    await assert.rejects(generateEmbeddings([chunk(0, { text: privateText })], upstream.options), (error) => {
      expectError(code, status)(error);
      assertRedacted(error, fakeKey, privateText);
      return true;
    });
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.waits, []);
  }
});

test("408 and server-side temporary errors can recover on retry", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const upstream = transport((body, attempt) => attempt === 1 ? new Response("private error", { status }) : responseFor(body.input));
    assert.equal((await generateEmbeddings([chunk()], upstream.options)).length, 1);
    assert.deepEqual(upstream.waits, [500]);
  }
});

test("a later batch retries independently without resending successful earlier batches", async () => {
  process.env.RAG_EMBEDDING_BATCH_SIZE = "2";
  const upstream = transport((body, attempt) => attempt === 2 ? new Response("busy", { status: 503 }) : responseFor(body.input));
  const input = [chunk(0), chunk(1), chunk(2)];
  const result = await generateEmbeddings(input, upstream.options);
  assert.deepEqual(upstream.calls.map((call) => call.body.input), [
    [input[0].text, input[1].text], [input[2].text], [input[2].text],
  ]);
  assert.deepEqual(result.map((entry) => entry.id), input.map((entry) => entry.id));
});

test("dimension changes in later batches fail the whole operation rather than returning partial results", async () => {
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  process.env.RAG_EMBEDDING_BATCH_SIZE = "1";
  const upstream = transport((body, attempt) => responseFor(body.input, attempt === 1 ? 3 : 4));
  await assert.rejects(generateEmbeddings([chunk(0), chunk(1)], upstream.options), expectError("INVALID_RESPONSE"));
  assert.equal(upstream.calls.length, 2);
});

function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DOMException("Private transport details", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

test("a timed-out request can recover and its timeout does not affect the retry", async () => {
  process.env.RAG_EMBEDDING_TIMEOUT_MS = "5";
  const upstream = transport((body, attempt, init) => attempt === 1 ? rejectOnAbort(init.signal) : responseFor(body.input));
  assert.equal((await generateEmbeddings([chunk()], upstream.options)).length, 1);
  assert.deepEqual(upstream.waits, [500]);
  assert.ok(upstream.calls[0].init.signal.aborted);
  assert.ok(!upstream.calls[1].init.signal.aborted);
});

test("timeout covers response body reading as well as response headers", async () => {
  process.env.RAG_EMBEDDING_TIMEOUT_MS = "5";
  process.env.RAG_EMBEDDING_MAX_RETRIES = "0";
  const upstream = transport((_body, _attempt, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"data":['));
      init.signal.addEventListener("abort", () => controller.error(new DOMException("Private error", "AbortError")), { once: true });
    },
  })));
  await assert.rejects(generateEmbeddings([chunk()], upstream.options), expectError("REQUEST_TIMEOUT"));
  assert.equal(upstream.calls.length, 1);
});

test("pre-cancelled requests and cancellation during a request never retry", async () => {
  const controller = new AbortController();
  controller.abort("private cancellation reason");
  const upstream = transport();
  await assert.rejects(generateEmbeddings([chunk()], { ...upstream.options, signal: controller.signal }), expectError("CANCELLED"));
  assert.equal(upstream.calls.length, 0);

  const active = new AbortController();
  const interrupted = transport((_body, _attempt, init) => {
    const pending = rejectOnAbort(init.signal);
    active.abort("another private reason");
    return pending;
  });
  await assert.rejects(generateEmbeddings([chunk()], { ...interrupted.options, signal: active.signal }), expectError("CANCELLED"));
  assert.equal(interrupted.calls.length, 1);
  assert.deepEqual(interrupted.waits, []);
});

test("cancellation during backoff stops before another API request", async () => {
  const controller = new AbortController();
  const upstream = transport(() => new Response("busy", { status: 429 }));
  await assert.rejects(generateEmbeddings([chunk()], {
    ...upstream.options, signal: controller.signal,
    sleep: async () => { controller.abort("private reason"); throw new Error("private reason"); },
  }), expectError("CANCELLED"));
  assert.equal(upstream.calls.length, 1);
});

test("transport errors cannot leak credentials or document contents and nothing is logged", async () => {
  process.env.RAG_EMBEDDING_MAX_RETRIES = "0";
  const logs = ["log", "warn", "error", "debug", "info"].map((name) => mock.method(console, name, () => {}));
  const privateText = "private document contents";
  const upstream = transport(() => { throw new Error(`${fakeKey}: ${privateText}`); });
  await assert.rejects(generateEmbeddings([chunk(0, { text: privateText })], upstream.options), (error) => {
    expectError("NETWORK_ERROR")(error);
    assertRedacted(error, fakeKey, privateText);
    return true;
  });
  assert.ok(logs.every((entry) => entry.mock.callCount() === 0));
});

test("missing credentials never fall back to an unrelated OpenAI key", async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = "unrelated-provider-key";
  await assert.rejects(generateEmbeddings([chunk()]), expectError("CONFIGURATION_ERROR"));
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("invalid server configuration is rejected before API calls", async () => {
  for (const key of ["", "   ", "invalid\nkey"]) {
    process.env.OPENROUTER_API_KEY = key;
    await assert.rejects(generateEmbeddings([chunk()]), expectError("CONFIGURATION_ERROR"));
  }
  process.env.OPENROUTER_API_KEY = fakeKey;
  for (const model of ["", " ", "invalid\nmodel"]) {
    process.env.RAG_EMBEDDING_MODEL = model;
    await assert.rejects(generateEmbeddings([chunk()]), expectError("CONFIGURATION_ERROR"));
  }
  delete process.env.RAG_EMBEDDING_MODEL;
  for (const [name, value] of [
    ["RAG_EMBEDDING_DIMENSIONS", "0"], ["RAG_EMBEDDING_DIMENSIONS", "65537"],
    ["RAG_EMBEDDING_BATCH_SIZE", "0"], ["RAG_EMBEDDING_BATCH_SIZE", "129"],
    ["RAG_EMBEDDING_TIMEOUT_MS", "0"], ["RAG_EMBEDDING_TIMEOUT_MS", "120001"],
    ["RAG_EMBEDDING_MAX_RETRIES", "-1"], ["RAG_EMBEDDING_MAX_RETRIES", "6"],
    ["RAG_EMBEDDING_BATCH_SIZE", "1.5"], ["RAG_EMBEDDING_BATCH_SIZE", ""],
  ]) {
    process.env[name] = value;
    await assert.rejects(generateEmbeddings([chunk()]), expectError("CONFIGURATION_ERROR"));
    delete process.env[name];
  }
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("invalid chunks and transport options fail without contacting the API", async () => {
  for (const input of [null, undefined, "text", {}]) {
    await assert.rejects(generateEmbeddings(input), expectError("INVALID_INPUT"));
  }
  for (const entry of [null, {}, chunk(0, { id: "" }), chunk(0, { documentId: "" }),
    chunk(0, { sourceName: " " }), chunk(0, { text: " \n" }), chunk(0, { text: null }),
    chunk(0, { pageNumber: 0 }), chunk(0, { pageNumber: 1.5 }), chunk(0, { chunkIndex: -1 })]) {
    await assert.rejects(generateEmbeddings([entry]), expectError("INVALID_INPUT"));
  }
  for (const options of [null, [], "options", { fetch: null }, { sleep: 42 }, { signal: {} }]) {
    await assert.rejects(generateEmbeddings([chunk()], options), expectError("INVALID_INPUT"));
  }
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("browser execution is rejected before reading credentials or issuing requests", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    await assert.rejects(generateEmbeddings([chunk()]), expectError("CONFIGURATION_ERROR"));
    assert.equal(defaultFetch.mock.callCount(), 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});

test("Step 1 PDF extraction and Step 4 chunks compose with mockable embedding generation", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chunks = await splitText(await extractText(path.join(root, "public/documents/taskflow/01_Product_Guide.pdf")));
  const original = structuredClone(chunks);
  const result = await generateEmbeddings(chunks, transport().options);
  assert.deepEqual(chunks, original);
  assert.equal(result.length, chunks.length);
  assert.deepEqual(result.map(({ embedding, ...metadata }) => {
    assert.equal(embedding.length, 1024);
    assert.ok(embedding.every(Number.isFinite));
    return metadata;
  }), chunks);
});
