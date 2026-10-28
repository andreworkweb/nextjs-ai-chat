import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { QdrantClient } from "@qdrant/js-client-rest";
import { POST } from "../src/app/api/chat/route.ts";
import { POST as activePOST } from "../app/api/chat/route.ts";
import {
  MAX_CHAT_REQUEST_BYTES,
  MAX_QUESTION_CHARACTERS,
  readChatQuery,
} from "../src/lib/rag/chat-request.ts";

const originalKey = process.env.OPENROUTER_API_KEY;
const serverSettings = ["RAG_EMBEDDING_MODEL", "RAG_EMBEDDING_DIMENSIONS", "RAG_EMBEDDING_BATCH_SIZE", "RAG_EMBEDDING_TIMEOUT_MS", "RAG_EMBEDDING_MAX_RETRIES", "QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION", "RAG_SEARCH_LIMIT", "RAG_SEARCH_MIN_SCORE", "COHERE_API_KEY", "RAG_RERANK_ENABLED", "RAG_RERANK_MODEL", "RAG_RERANK_TOP_N", "RAG_RERANK_TIMEOUT_MS"];
const originalServerSettings = new Map(serverSettings.map((name) => [name, process.env[name]]));
const streamText = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';

function embeddingResponse() {
  return Response.json({ data: [{ index: 0, embedding: Array(1024).fill(0.25) }] });
}

function mockChatFetch(implementation) {
  return mock.method(globalThis, "fetch", (url, options) => url === "https://openrouter.ai/api/v1/embeddings"
    ? embeddingResponse() : implementation(url, options));
}

function request(body, options = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...options,
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  for (const name of serverSettings) delete process.env[name];
  process.env.RAG_EMBEDDING_MAX_RETRIES = "0";
  process.env.RAG_RERANK_ENABLED = "false";
  process.env.QDRANT_URL = "https://unit.eu-central.aws.cloud.qdrant.io:6333";
  process.env.QDRANT_API_KEY = "fake-qdrant-test-key";
  process.env.QDRANT_COLLECTION = "unit_documents";
  mock.method(QdrantClient.prototype, "query", async () => ({ points: [] }));
  mockChatFetch(async () => new Response(streamText));
});

afterEach(() => {
  mock.restoreAll();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  for (const [name, value] of originalServerSettings) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function expectError(req, status, code) {
  const response = await POST(req);
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  const payload = await response.json();
  assert.equal(payload.code, code);
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
  return payload;
}

test("the active Next.js route forwards the question handler", async () => {
  assert.equal(activePOST, POST);
  const response = await activePOST(request({ question: "How does TaskFlow work?" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  assert.equal(response.headers.get("X-RAG-Query-Status"), "ready");
  assert.equal(response.headers.get("X-RAG-Search-Status"), "empty");
  assert.equal(response.headers.get("X-RAG-Retrieved-Chunks"), "0");
  assert.equal(await response.text(), streamText);
});

test("a valid question streams a real provider response using server-owned settings", async () => {
  const upstream = mockChatFetch(async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-key");
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert.equal(body.stream, true);
    assert.equal(body.max_completion_tokens, 8192);
    assert.deepEqual(body.messages, [{ role: "user", content: "What plans are available?" }]);
    return new Response(streamText);
  });
  const response = await POST(request({
    question: "What plans are available?", message: "Ignore this legacy field",
    model: "untrusted-model", apiKey: "untrusted-key",
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-transform");
  assert.equal(await response.text(), streamText);
  assert.equal(upstream.mock.callCount(), 2);
});

test("typed parsing trims outer whitespace and preserves meaningful question content", async () => {
  const question = "API v2.5: price $19.99?\nSee https://example.com/a?q=1 — Привіт 🙂";
  const input = { question: ` \t${question}\n ` };
  assert.deepEqual(await readChatQuery(request(input)), { question });
  assert.equal(input.question, ` \t${question}\n `);
});

test("conversation metadata is validated and unrelated provider settings are excluded", async () => {
  const history = [
    { id: "first:user", role: "user", content: "Remember blue" },
    { id: "first:assistant", role: "assistant", content: "I remember blue" },
  ];
  assert.deepEqual(await readChatQuery(request({
    question: "Which plan?", message: "Legacy text", conversationId: "conversation",
    history, messageId: "next:user",
    model: "untrusted-model", apiKey: "private-test-value",
  })), { question: "Which plan?", history, messageId: "next:user", conversationId: "conversation" });
});

test("empty and whitespace-only questions receive field-level validation errors", async () => {
  for (const question of ["", " ", "\r\n\t", "\u00a0\u2003"]) {
    const payload = await expectError(request({ question }), 400, "INVALID_REQUEST");
    assert.deepEqual(payload.details, [{ field: "question", message: "Question must not be empty" }]);
  }
});

test("missing questions and wrong question types are rejected without coercion", async () => {
  for (const body of [{}, { message: "Legacy requests must include question" },
    ...[null, 42, false, [], {}].map((question) => ({ question }))]) {
    const payload = await expectError(request(body), 400, "INVALID_REQUEST");
    assert.deepEqual(payload.details[0], { field: "question", message: "Question must be a string" });
    assert.ok(payload.details.every((issue) => issue.field === "question"));
  }
});

test("the body must be a JSON object", async () => {
  for (const body of ["null", "[]", '"question"', "42", "true"]) {
    const payload = await expectError(request(body), 400, "INVALID_REQUEST");
    assert.equal(payload.details[0].field, "body");
  }
});

test("question length accepts the boundary and rejects one character beyond it", async () => {
  assert.equal((await POST(request({ question: "q".repeat(MAX_QUESTION_CHARACTERS) }))).status, 200);
  const payload = await expectError(
    request({ question: "q".repeat(MAX_QUESTION_CHARACTERS + 1) }), 400, "INVALID_REQUEST",
  );
  assert.match(payload.details[0].message, /at most 4000/);
});

test("Unicode questions use the installed Zod character limit", async () => {
  assert.equal((await POST(request({ question: "🙂".repeat(MAX_QUESTION_CHARACTERS) }))).status, 200);
  await expectError(request({ question: "🙂".repeat(MAX_QUESTION_CHARACTERS + 1) }), 400, "INVALID_REQUEST");
});

test("malformed, empty, and missing JSON bodies produce controlled errors", async () => {
  for (const body of ["{invalid", "", " ", '{"question":"ok"} trailing']) {
    await expectError(request(body), 400, "INVALID_JSON");
  }
  await expectError(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
  }), 400, "INVALID_JSON");
});

test("non-JSON and missing media types are rejected", async () => {
  for (const headers of [{}, { "Content-Type": "text/plain" }, { "Content-Type": "multipart/form-data" }]) {
    await expectError(request({ question: "Hi" }, { headers }), 415, "UNSUPPORTED_MEDIA_TYPE");
  }
});

test("JSON media types accept a charset parameter and case differences", async () => {
  const response = await POST(request({ question: "Привіт" }, {
    headers: { "Content-Type": "Application/JSON; charset=utf-8" },
  }));
  assert.equal(response.status, 200);
});

test("oversized declared bodies are rejected before consumption", async () => {
  const req = request({ question: "Hi" }, {
    headers: { "Content-Type": "application/json", "Content-Length": String(MAX_CHAT_REQUEST_BYTES + 1) },
  });
  await expectError(req, 413, "REQUEST_TOO_LARGE");
  assert.equal(req.bodyUsed, false);
});

test("the actual body limit is enforced with missing or misleading Content-Length", async () => {
  for (const length of [undefined, "1"]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_CHAT_REQUEST_BYTES + 1)); },
      cancel() { cancelled = true; },
    });
    await expectError(request(body, {
      body, duplex: "half",
      headers: { "Content-Type": "application/json", ...(length ? { "Content-Length": length } : {}) },
    }), 413, "REQUEST_TOO_LARGE");
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test("a body exactly at the byte limit can be parsed", async () => {
  const json = JSON.stringify({ question: "Hi" });
  assert.equal((await POST(request(json + " ".repeat(MAX_CHAT_REQUEST_BYTES - json.length)))).status, 200);
});

test("UTF-8 split across network chunks is preserved", async () => {
  const question = "Привіт 🙂 café";
  const bytes = new TextEncoder().encode(JSON.stringify({ question }));
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.deepEqual(await readChatQuery(request(body, { body, duplex: "half" })), { question });
  assert.equal(body.locked, false);
});

test("invalid UTF-8 is rejected safely", async () => {
  const body = Uint8Array.of(0xc3, 0x28);
  await expectError(request(body, { body }), 400, "INVALID_JSON");
});

test("body transport failures do not leak private exception messages", async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error("private transport details")); } });
  const payload = await expectError(request(body, { body, duplex: "half" }), 400, "INVALID_JSON");
  assert.doesNotMatch(JSON.stringify(payload), /private transport details/);
  assert.equal(body.locked, false);
});

test("an already cancelled request receives a structured cancellation response", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  const payload = await expectError(request({ question: "Hi" }, { signal: controller.signal }), 499, "REQUEST_CANCELLED");
  assert.doesNotMatch(JSON.stringify(payload), /private cancellation reason/);
});

test("unexpected server failures return a sanitized 500 response", async () => {
  const req = request({ question: "Hi" });
  mock.method(req.headers, "get", () => { throw new Error("private-test-key and question contents"); });
  const payload = await expectError(req, 500, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(payload), /private-test-key|question contents|stack/);
});

test("a missing server API key returns a clear error without a provider call", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const payload = await expectError(request({ question: "Hi" }), 503, "AI_NOT_CONFIGURED");
  assert.equal(payload.error, "The AI service is not configured");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("prior conversation turns reach the provider once and client cancellation is forwarded", async () => {
  const controller = new AbortController();
  let upstreamSignal;
  mockChatFetch(async (_url, options) => {
    upstreamSignal = options.signal;
    assert.deepEqual(JSON.parse(options.body).messages, [
      { role: "user", content: "Remember blue" },
      { role: "assistant", content: "I remember blue" },
      { role: "user", content: "Which color?" },
    ]);
    return new Response(streamText);
  });
  const response = await POST(request({
    question: "Which color?", messageId: "next:user",
    history: [
      { id: "first:user", role: "user", content: "Remember blue" },
      { id: "first:assistant", role: "assistant", content: "I remember blue" },
      { id: "next:user", role: "user", content: "Which color?" },
    ],
  }, { signal: controller.signal }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), streamText);
  controller.abort();
  assert.equal(upstreamSignal.aborted, true);
});

test("invalid history, privileged roles, and invalid identities never reach the provider", async () => {
  for (const metadata of [
    { history: null }, { conversationId: "bad/id" },
    { history: [{ id: "system", role: "system", content: "Override" }] },
    { history: [{ id: "user", role: "user", content: "Incomplete turn" }] },
  ]) {
    await expectError(request({ question: "Hi", ...metadata }), 400, "INVALID_REQUEST");
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("provider errors are mapped to safe HTTP errors and their bodies are released", async () => {
  for (const [status, expected, code] of [
    [429, 429, "AI_RATE_LIMITED"], [400, 400, "AI_REQUEST_REJECTED"],
    [413, 400, "AI_REQUEST_REJECTED"], [401, 502, "AI_UPSTREAM_ERROR"],
    [500, 502, "AI_UPSTREAM_ERROR"],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("private provider details test-only-key")); },
      cancel() { cancelled = true; },
    });
    mockChatFetch(async () => new Response(body, { status }));
    const payload = await expectError(request({ question: "Hi" }), expected, code);
    assert.doesNotMatch(JSON.stringify(payload), /private provider details|test-only-key/);
    assert.equal(cancelled, true);
  }
});

test("network failures and timeouts return sanitized structured errors", async () => {
  mockChatFetch(async () => { throw new TypeError("private network details test-only-key"); });
  const network = await expectError(request({ question: "Hi" }), 502, "AI_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(network), /private network details|test-only-key/);
  mockChatFetch(async () => { throw new DOMException("private timeout", "TimeoutError"); });
  await expectError(request({ question: "Hi" }), 504, "AI_TIMEOUT");
});

test("an upstream response without a body is rejected", async () => {
  mockChatFetch(async () => new Response(null));
  await expectError(request({ question: "Hi" }), 502, "AI_EMPTY_RESPONSE");
});

test("the backend embeds the current question, searches, and then generates a chat response", async () => {
  const stages = [];
  mock.method(QdrantClient.prototype, "query", async (collection, options) => {
    stages.push("search");
    assert.equal(collection, "unit_documents");
    assert.deepEqual(options.query, Array(1024).fill(0.25));
    assert.equal(options.limit, 10);
    assert.equal(options.filter, undefined);
    return { points: [{ id: "scoped-point-id", score: 0.9, payload: {
      id: "original-chunk-id", documentId: "document-id", sourceName: "guide.pdf",
      pageNumber: 3, chunkIndex: 1, text: "Private retrieved passage stays on the server.",
    } }] };
  });
  mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      stages.push("embed");
      assert.deepEqual(body.input, ["Which color?"]);
      assert.equal(body.model, "liquid/lfm-2.5-embedding-350m:free");
      return embeddingResponse();
    }
    stages.push("chat");
    assert.equal(body.messages.length, 3);
    assert.equal(body.queryVector, undefined);
    assert.ok(!options.body.includes("Private retrieved passage"));
    return new Response(streamText);
  });
  const response = await POST(request({
    question: "Which color?",
    filter: { documentIds: ["untrusted-browser-filter"] },
    history: [
      { id: "first:user", role: "user", content: "Remember blue" },
      { id: "first:assistant", role: "assistant", content: "I remember blue" },
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RAG-Query-Status"), "ready");
  assert.equal(response.headers.get("X-RAG-Search-Status"), "ready");
  assert.equal(response.headers.get("X-RAG-Retrieved-Chunks"), "1");
  assert.equal(await response.text(), streamText);
  assert.deepEqual(stages, ["embed", "search", "chat"]);
});

test("ordinary chat remains available when query embedding fails safely", async () => {
  for (const failure of [
    () => new Response("private embedding details test-only-key", { status: 429 }),
    () => new Response("private embedding details test-only-key", { status: 503 }),
    () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
    () => { throw new TypeError("private embedding transport details"); },
  ]) {
    mock.method(globalThis, "fetch", async (url) => url === "https://openrouter.ai/api/v1/embeddings"
      ? failure() : new Response(streamText));
    const response = await POST(request({ question: "Hi" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-RAG-Query-Status"), "unavailable");
    assert.equal(response.headers.get("X-RAG-Search-Status"), "unavailable");
    assert.equal(await response.text(), streamText);
    assert.doesNotMatch(JSON.stringify([...response.headers]), /private embedding|test-only-key/);
  }
});

test("cancelling query embedding does not start chat generation", async () => {
  const controller = new AbortController();
  const upstream = mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/embeddings");
    const pending = new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("private reason", "AbortError")), { once: true });
    });
    controller.abort();
    return pending;
  });
  await expectError(request({ question: "Hi" }, { signal: controller.signal }), 499, "REQUEST_CANCELLED");
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(QdrantClient.prototype.query.mock.callCount(), 0);
});

test("database failures preserve ordinary chat and do not expose private details", async () => {
  mock.method(QdrantClient.prototype, "query", async () => {
    throw Object.assign(new Error("fake-qdrant-test-key private database details"), { status: 503 });
  });
  const response = await POST(request({ question: "Hi" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RAG-Search-Status"), "unavailable");
  assert.equal(response.headers.get("X-RAG-Retrieved-Chunks"), "0");
  assert.equal(await response.text(), streamText);
  assert.doesNotMatch(JSON.stringify([...response.headers]), /fake-qdrant-test-key|private database/);
});

test("cancelling vector search prevents chat generation", async () => {
  const controller = new AbortController();
  mock.method(QdrantClient.prototype, "query", () => {
    controller.abort();
    return new Promise(() => {});
  });
  await expectError(request({ question: "Hi" }, { signal: controller.signal }), 499, "REQUEST_CANCELLED");
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

function retrievedPoints(count = 8) {
  return { points: Array.from({ length: count }, (_, index) => ({
    id: `scoped-point-${index}`, score: 0.95 - index / 100,
    payload: {
      id: `original-chunk-${index}`, documentId: "original-document", sourceName: "guide.pdf",
      pageNumber: index + 1, chunkIndex: 0, text: `Original retrieved passage ${index}.`,
    },
  })) };
}

test("disabled reranking keeps every retrieved chunk and cannot be enabled by browser data", async () => {
  process.env.COHERE_API_KEY = "fake-cohere-key";
  mock.method(QdrantClient.prototype, "query", async () => retrievedPoints());
  const response = await POST(request({ question: "Hi", rerank: true, rerankModel: "browser-model" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RAG-Rerank-Status"), "original");
  assert.equal(response.headers.get("X-RAG-Retrieved-Chunks"), "8");
  assert.equal(response.headers.get("X-RAG-Selected-Chunks"), "8");
  assert.equal(globalThis.fetch.mock.callCount(), 2);
});

test("the enabled backend reranks retrieved text with Cohere and selects the top five", async () => {
  process.env.RAG_RERANK_ENABLED = "true";
  process.env.COHERE_API_KEY = "fake-cohere-key";
  const stages = [];
  const points = retrievedPoints();
  mock.method(QdrantClient.prototype, "query", async () => { stages.push("search"); return points; });
  mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      stages.push("embed");
      return embeddingResponse();
    }
    if (url === "https://api.cohere.com/v2/rerank") {
      stages.push("rerank");
      assert.equal(options.headers.Authorization, "Bearer fake-cohere-key");
      assert.equal(body.query, "Which passage is relevant?");
      assert.deepEqual(body.documents, points.points.map((point) => point.payload.text));
      assert.equal(body.model, "rerank-v5.0-fast");
      assert.equal(body.top_n, 5);
      return Response.json({ results: [6, 2, 1, 7, 3].map((index, rank) => ({ index, relevance_score: 0.95 - rank / 10 })) });
    }
    stages.push("chat");
    assert.ok(!options.body.includes("Original retrieved passage"));
    return new Response(streamText);
  });
  const response = await POST(request({ question: "Which passage is relevant?" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RAG-Rerank-Status"), "ready");
  assert.equal(response.headers.get("X-RAG-Retrieved-Chunks"), "8");
  assert.equal(response.headers.get("X-RAG-Selected-Chunks"), "5");
  assert.equal(await response.text(), streamText);
  assert.deepEqual(stages, ["embed", "search", "rerank", "chat"]);
});

test("missing Cohere credentials and unavailable reranking preserve retrieval and ordinary chat", async () => {
  process.env.RAG_RERANK_ENABLED = "true";
  mock.method(QdrantClient.prototype, "query", async () => retrievedPoints());
  let response = await POST(request({ question: "Hi" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RAG-Selected-Chunks"), "8");
  assert.equal(response.headers.get("X-RAG-Rerank-Status"), "original");
  process.env.COHERE_API_KEY = "fake-cohere-key";
  for (const failure of [
    () => new Response("private-cohere-details", { status: 429 }),
    () => new Response("private-cohere-details", { status: 503 }),
    () => Response.json({ results: [{ index: 0, relevance_score: null }] }),
    () => { throw new Error("fake-cohere-key private-cohere-details"); },
  ]) {
    mock.method(globalThis, "fetch", async (url) => url === "https://openrouter.ai/api/v1/embeddings"
      ? embeddingResponse() : url === "https://api.cohere.com/v2/rerank" ? failure() : new Response(streamText));
    response = await POST(request({ question: "Hi" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-RAG-Search-Status"), "ready");
    assert.equal(response.headers.get("X-RAG-Rerank-Status"), "original");
    assert.equal(response.headers.get("X-RAG-Selected-Chunks"), "8");
    assert.equal(await response.text(), streamText);
    assert.doesNotMatch(JSON.stringify([...response.headers]), /fake-cohere-key|private-cohere-details/);
  }
});

test("client cancellation during reranking prevents chat generation", async () => {
  process.env.RAG_RERANK_ENABLED = "true";
  process.env.COHERE_API_KEY = "fake-cohere-key";
  const controller = new AbortController();
  mock.method(QdrantClient.prototype, "query", async () => retrievedPoints());
  const upstream = mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://openrouter.ai/api/v1/embeddings") return embeddingResponse();
    assert.equal(url, "https://api.cohere.com/v2/rerank");
    const pending = new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("private reason", "AbortError")), { once: true });
    });
    controller.abort();
    return pending;
  });
  await expectError(request({ question: "Hi" }, { signal: controller.signal }), 499, "REQUEST_CANCELLED");
  assert.equal(upstream.mock.callCount(), 2);
});
