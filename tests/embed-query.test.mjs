import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { embedQuery } from "../src/lib/rag/embed-query.ts";
import { EmbeddingGenerationError, generateEmbeddings } from "../src/lib/rag/generate-embeddings.ts";

const environmentNames = [
  "OPENROUTER_API_KEY", "RAG_EMBEDDING_MODEL", "RAG_EMBEDDING_DIMENSIONS",
  "RAG_EMBEDDING_BATCH_SIZE", "RAG_EMBEDDING_TIMEOUT_MS", "RAG_EMBEDDING_MAX_RETRIES",
];
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
const fakeKey = "query-unit-test-key";
let defaultFetch;

beforeEach(() => {
  for (const name of environmentNames) delete process.env[name];
  process.env.OPENROUTER_API_KEY = fakeKey;
  defaultFetch = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected live request"); });
});

afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function response(dimensions = 1024) {
  return Response.json({ data: [{ index: 0, embedding: Array(dimensions).fill(0.25) }] });
}

function transport(respond = () => response()) {
  const calls = [];
  const waits = [];
  return {
    calls, waits,
    options: {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        return respond(body, calls.length, init);
      },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    },
  };
}

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof EmbeddingGenerationError);
    assert.equal(error.code, code);
    return true;
  };
}

test("a question produces one finite 1024-dimensional vector using the ingestion defaults", async () => {
  const upstream = transport();
  const vector = await embedQuery("How do I authenticate?", upstream.options);
  assert.equal(vector.length, 1024);
  assert.ok(vector.every((value) => typeof value === "number" && Number.isFinite(value)));
  assert.equal(upstream.calls.length, 1);
  const { url, init, body } = upstream.calls[0];
  assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
  assert.equal(init.headers.Authorization, `Bearer ${fakeKey}`);
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.deepEqual(body, {
    model: "liquid/lfm-2.5-embedding-350m:free",
    input: ["How do I authenticate?"], encoding_format: "float",
  });
  assert.equal(body.documentId, undefined);
});

test("query and document paths share exactly the same model, dimensions, and text request", async () => {
  process.env.RAG_EMBEDDING_MODEL = "test/shared-embedding-model";
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  process.env.RAG_EMBEDDING_BATCH_SIZE = "1";
  const text = "API v2.5 at https://example.com: 42 — Привіт 🙂";
  const upstream = transport(() => response(3));
  const [document] = await generateEmbeddings([{
    id: "original-chunk-id", documentId: "original-document-id", sourceName: "guide.md",
    pageNumber: 2, chunkIndex: 0, text,
  }], upstream.options);
  const query = await embedQuery(text, upstream.options);
  assert.deepEqual(query, document.embedding);
  assert.deepEqual(upstream.calls[0].body, upstream.calls[1].body);
  assert.equal(query.length, 3);
  assert.equal(document.id, "original-chunk-id");
  assert.equal(document.documentId, "original-document-id");
});

test("the whole question is embedded once without splitting, rewriting, or truncation", async () => {
  const question = " \tURL https://example.com/a?q=3, price $19.99.\nC++ RAG v2.5 🙂 ".repeat(50);
  const upstream = transport();
  await embedQuery(question, upstream.options);
  assert.deepEqual(upstream.calls.map((call) => call.body.input), [[question]]);
});

test("empty and non-string questions are rejected before any API call", async () => {
  const upstream = transport();
  for (const question of [undefined, null, 42, false, [], {}, "", " \t\r\n", "\u00a0"]) {
    await assert.rejects(embedQuery(question, upstream.options), errorCode("INVALID_INPUT"));
  }
  assert.equal(upstream.calls.length, 0);
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("dimension mismatches, non-numbers, and non-finite values never escape validation", async () => {
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  for (const embedding of [[], [1, 2], [1, 2, 3, 4], [1, "2", 3], [1, null, 3], [1, {}, 3], "invalid"]) {
    const upstream = transport(() => Response.json({ data: [{ index: 0, embedding }] }));
    await assert.rejects(embedQuery("Question", upstream.options), errorCode("INVALID_RESPONSE"));
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.waits, []);
  }
  const overflow = transport(() => new Response('{"data":[{"index":0,"embedding":[1,1e999,3]}]}'));
  await assert.rejects(embedQuery("Question", overflow.options), errorCode("INVALID_RESPONSE"));
});

test("missing, multiple, or misindexed vectors and malformed JSON are rejected", async () => {
  for (const invalid of [
    () => Response.json({ data: [] }),
    () => Response.json({ data: [{ index: 1, embedding: Array(1024).fill(1) }] }),
    () => Response.json({ data: [{ embedding: Array(1024).fill(1) }] }),
    () => Response.json({ data: [0, 1].map((index) => ({ index, embedding: Array(1024).fill(1) })) }),
    () => new Response("not JSON"),
  ]) {
    const upstream = transport(invalid);
    await assert.rejects(embedQuery("Question", upstream.options), errorCode("INVALID_RESPONSE"));
    assert.equal(upstream.calls.length, 1);
  }
});

test("query rate limits and temporary failures reuse bounded exponential retries", async () => {
  const upstream = transport((_body, attempt) => attempt < 4
    ? new Response("private error", { status: attempt === 1 ? 429 : 503 }) : response());
  assert.equal((await embedQuery("Question", upstream.options)).length, 1024);
  assert.equal(upstream.calls.length, 4);
  assert.deepEqual(upstream.waits, [500, 1000, 2000]);
  assert.ok(upstream.calls.every((call) => call.init.body === upstream.calls[0].init.body));
});

test("an exhausted rate limit preserves its safe error code and Retry-After", async () => {
  process.env.RAG_EMBEDDING_MAX_RETRIES = "0";
  const upstream = transport(() => new Response(`${fakeKey} private question`, {
    status: 429, headers: { "Retry-After": "3" },
  }));
  await assert.rejects(embedQuery("private question", upstream.options), (error) => {
    errorCode("RATE_LIMITED")(error);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 3000);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /query-unit-test-key|private question/);
    return true;
  });
  assert.equal(upstream.calls.length, 1);
});

test("authentication and permanent provider errors are safe and are not retried", async () => {
  for (const [status, code] of [[401, "AUTHENTICATION_FAILED"], [403, "AUTHENTICATION_FAILED"], [400, "REQUEST_REJECTED"]]) {
    const upstream = transport(() => new Response(`${fakeKey} private question`, { status }));
    await assert.rejects(embedQuery("private question", upstream.options), (error) => {
      errorCode(code)(error);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /query-unit-test-key|private question/);
      return true;
    });
    assert.equal(upstream.calls.length, 1);
    assert.deepEqual(upstream.waits, []);
  }
});

test("transport failures neither log nor expose query text or credentials", async () => {
  process.env.RAG_EMBEDDING_MAX_RETRIES = "1";
  const logs = ["log", "error", "warn", "debug", "info"].map((name) => mock.method(console, name, () => {}));
  const upstream = transport(() => { throw new Error(`${fakeKey} private question`); });
  await assert.rejects(embedQuery("private question", upstream.options), (error) => {
    errorCode("NETWORK_ERROR")(error);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /query-unit-test-key|private question/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(upstream.waits, [500]);
  assert.ok(logs.every((entry) => entry.mock.callCount() === 0));
});

test("timeouts and retry limits use the existing ingestion environment settings", async () => {
  process.env.RAG_EMBEDDING_TIMEOUT_MS = "5";
  process.env.RAG_EMBEDDING_MAX_RETRIES = "1";
  const upstream = transport((_body, _attempt, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("private timeout", "AbortError")), { once: true });
  }));
  await assert.rejects(embedQuery("Question", upstream.options), errorCode("REQUEST_TIMEOUT"));
  assert.equal(upstream.calls.length, 2);
  assert.deepEqual(upstream.waits, [500]);
});

test("cancellation is forwarded and never causes a retry", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const upstream = transport();
  await assert.rejects(embedQuery("Question", { ...upstream.options, signal: cancelled.signal }), errorCode("CANCELLED"));
  assert.equal(upstream.calls.length, 0);

  const active = new AbortController();
  const interrupted = transport((_body, _attempt, init) => {
    const pending = new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("private reason", "AbortError")), { once: true });
    });
    active.abort();
    return pending;
  });
  await assert.rejects(embedQuery("Question", { ...interrupted.options, signal: active.signal }), errorCode("CANCELLED"));
  assert.equal(interrupted.calls.length, 1);
  assert.deepEqual(interrupted.waits, []);
});

test("missing credentials and invalid shared dimensions fail before transport", async () => {
  delete process.env.OPENROUTER_API_KEY;
  await assert.rejects(embedQuery("Question"), errorCode("CONFIGURATION_ERROR"));
  process.env.OPENROUTER_API_KEY = fakeKey;
  process.env.RAG_EMBEDDING_DIMENSIONS = "0";
  await assert.rejects(embedQuery("Question"), errorCode("CONFIGURATION_ERROR"));
  assert.equal(defaultFetch.mock.callCount(), 0);
});

test("the default HTTP transport remains mockable", async () => {
  defaultFetch.mock.mockImplementation(async () => response());
  assert.equal((await embedQuery("Question")).length, 1024);
  assert.equal(defaultFetch.mock.callCount(), 1);
});

test("browser execution is rejected before reading credentials or calling HTTP", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    await assert.rejects(embedQuery("Question"), errorCode("CONFIGURATION_ERROR"));
    assert.equal(defaultFetch.mock.callCount(), 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});
