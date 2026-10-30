import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { searchVectors } from "../src/lib/rag/search-vectors.ts";
import { QdrantStorageError, getQdrantConnection } from "../src/lib/rag/qdrant.ts";
import { extractText } from "../src/lib/rag/extract-text.ts";
import { splitText } from "../src/lib/rag/split-text.ts";
import { storeEmbeddings } from "../src/lib/rag/store-embeddings.ts";
import { embeddedChunk, fakeQdrant } from "./helpers/fake-qdrant.mjs";

const names = ["RAG_SEARCH_LIMIT", "RAG_SEARCH_MIN_SCORE", "QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION", "RAG_EMBEDDING_DIMENSIONS"];
const original = new Map(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of names) delete process.env[name];
});
afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof QdrantStorageError);
    assert.equal(error.code, code);
    return true;
  };
}

async function indexed(count = 14) {
  const fake = fakeQdrant();
  await storeEmbeddings(Array.from({ length: count }, (_, index) => embeddedChunk(index, {
    embedding: [1, index / 10, 0], pageNumber: 3,
  })), { connection: fake.connection });
  fake.calls.length = 0;
  return fake;
}

test("current query API returns the top 10 ranked chunks and original source metadata", async () => {
  const fake = await indexed();
  const vector = Object.freeze([1, 0, 0]);
  const results = await searchVectors(vector, { connection: fake.connection });
  assert.equal(results.length, 10);
  assert.deepEqual(results.map((result) => result.chunkId), Array.from({ length: 10 }, (_, index) => embeddedChunk(index).id));
  assert.deepEqual(results[0], {
    text: embeddedChunk(0).text, sourceName: "guide.txt", documentId: "document-version-one",
    chunkId: embeddedChunk(0).id, pageNumber: 3, page: 3, chunkIndex: 0, score: 1,
  });
  assert.ok(results.every((result, index) => !index || results[index - 1].score >= result.score));
  assert.deepEqual(fake.calls, [{ method: "query", args: ["unit_documents", {
    query: [1, 0, 0], limit: 10, with_vector: false,
    with_payload: ["text", "sourceName", "pageNumber", "documentId", "id", "chunkIndex"],
  }] }]);
  assert.notEqual(results[0].chunkId, [...fake.points.keys()][0]);
  assert.deepEqual(vector, [1, 0, 0]);
});

test("limits and minimum relevance work through options and server configuration", async () => {
  const fake = await indexed();
  process.env.RAG_SEARCH_LIMIT = "4";
  process.env.RAG_SEARCH_MIN_SCORE = "0.95";
  const configured = await searchVectors([1, 0, 0], { connection: fake.connection });
  assert.ok(configured.length > 0 && configured.length <= 4);
  assert.ok(configured.every((result) => result.score >= 0.95));
  const limited = await searchVectors([1, 0, 0], { connection: fake.connection, limit: 2, minScore: 0 });
  assert.equal(limited.length, 2);
  assert.equal(fake.calls.at(-1).args[1].score_threshold, 0);
  assert.equal(fake.calls.at(-1).args[1].limit, 2);
});

test("the document and source filters combine as AND restrictions inside Qdrant", async () => {
  const fake = fakeQdrant();
  await storeEmbeddings([
    embeddedChunk(0, { sourceName: "public/a.md", documentId: "allowed", embedding: [1, 0, 0] }),
    embeddedChunk(1, { sourceName: "public/b.md", documentId: "allowed", embedding: [1, 0, 0] }),
    embeddedChunk(2, { sourceName: "private/c.md", documentId: "restricted", embedding: [1, 0, 0] }),
  ], { connection: fake.connection });
  fake.calls.length = 0;
  const filter = Object.freeze({ documentIds: Object.freeze(["allowed"]), sourceNames: Object.freeze(["public/a.md"]) });
  const results = await searchVectors([1, 0, 0], { connection: fake.connection, filter });
  assert.deepEqual(results.map((result) => result.sourceName), ["public/a.md"]);
  assert.deepEqual(fake.calls[0].args[1].filter, { must: [
    { key: "documentId", match: { any: ["allowed"] } },
    { key: "sourceName", match: { any: ["public/a.md"] } },
  ] });
});

test("empty access allowlists return no results without contacting the database", async () => {
  const fake = fakeQdrant();
  for (const filter of [{ documentIds: [] }, { sourceNames: [] }, { documentIds: [], sourceNames: ["guide.txt"] }]) {
    assert.deepEqual(await searchVectors([1, 0, 0], { connection: fake.connection, filter }), []);
  }
  assert.deepEqual(fake.calls, []);
  // Denied access does not need cloud credentials at all.
  assert.deepEqual(await searchVectors([1, 0, 0], { filter: { documentIds: [] } }), []);
});

test("empty collections and searches with no matching metadata or score return empty arrays", async () => {
  const empty = fakeQdrant();
  assert.deepEqual(await searchVectors([1, 0, 0], { connection: empty.connection }), []);
  const fake = await indexed();
  assert.deepEqual(await searchVectors([1, 0, 0], { connection: fake.connection, filter: { documentIds: ["missing"] } }), []);
  assert.deepEqual(await searchVectors([0, 0, 1], { connection: fake.connection, minScore: 0.9 }), []);
});

test("invalid, sparse, zero, non-finite, or incompatible vectors never reach Qdrant", async () => {
  const fake = fakeQdrant();
  for (const vector of [null, undefined, "vector", {}, [], [1, 2], [1, NaN, 0], [1, Infinity, 0], [1, "0", 0], [0, 0, 0], Array(3)]) {
    await assert.rejects(searchVectors(vector, { connection: fake.connection }), errorCode("INVALID_INPUT"));
  }
  assert.deepEqual(fake.calls, []);
});

test("invalid search options and filter typos fail closed", async () => {
  const fake = fakeQdrant();
  const options = [null, [], { signal: {} },
    ...[0, -1, 101, 1.5, "3", NaN, null].map((limit) => ({ limit })),
    ...[-1.1, 1.1, NaN, Infinity, "0.5", null].map((minScore) => ({ minScore })),
    ...[null, [], "bad", new Date(), { documentId: ["typo"] }, { documentIds: null },
      { sourceNames: [""] }, { documentIds: [1] }, { documentIds: Array(1) },
      { documentIds: Array(1001).fill("too-many") }].map((filter) => ({ filter })),
  ];
  for (const value of options) {
    await assert.rejects(searchVectors([1, 0, 0], value && !Array.isArray(value)
      ? { ...value, connection: fake.connection } : value), errorCode("INVALID_INPUT"));
  }
  assert.deepEqual(fake.calls, []);
});

test("invalid environment settings are clear configuration errors and explicit options override them", async () => {
  const fake = await indexed();
  for (const [name, values] of [["RAG_SEARCH_LIMIT", ["", "1.5", "0", "101"]], ["RAG_SEARCH_MIN_SCORE", ["", "Infinity", "1.1", "bad"]]]) {
    for (const value of values) {
      process.env[name] = value;
      await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection }), errorCode("CONFIGURATION_ERROR"));
      assert.equal((await searchVectors([1, 0, 0], { connection: fake.connection, limit: 1, minScore: -1 })).length, 1);
    }
    delete process.env[name];
  }
});

test("database failures including a missing collection are meaningful errors, not empty results", async () => {
  const fake = fakeQdrant({ exists: false });
  await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection }), (error) => {
    errorCode("SEARCH_FAILED")(error);
    assert.equal(error.status, 404);
    return true;
  });
  const logs = ["log", "error", "warn"].map((name) => mock.method(console, name, () => {}));
  fake.client.query = async () => { throw Object.assign(new Error("secret-key private query data"), { status: 503 }); };
  await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection }), (error) => {
    errorCode("SEARCH_FAILED")(error);
    assert.equal(error.status, 503);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret-key|private query/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.ok(logs.every((log) => log.mock.callCount() === 0));
});

test("malformed results cannot fabricate citation metadata", async () => {
  const fake = await indexed(1);
  const point = { score: 0.9, payload: { ...embeddedChunk(0), embedding: undefined } };
  for (const result of [null, {}, { points: null }, { points: [null] },
    { points: [{ ...point, score: NaN }] },
    ...[{ text: "" }, { sourceName: null }, { id: 12 }, { documentId: undefined },
      { pageNumber: 0 }, { pageNumber: 1.5 }, { chunkIndex: -1 }].map((payload) => ({ points: [{ ...point, payload: { ...point.payload, ...payload } }] })),
  ]) {
    fake.client.query = async () => result;
    await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection }), errorCode("INVALID_RESPONSE"));
  }
});

test("unexpected out-of-scope database results are rejected before source text can be returned", async () => {
  const fake = fakeQdrant();
  fake.client.query = async () => ({ points: [{ score: 0.9, payload: embeddedChunk(0, { documentId: "restricted" }) }] });
  await assert.rejects(searchVectors([1, 0, 0], {
    connection: fake.connection, filter: { documentIds: ["allowed"] },
  }), errorCode("INVALID_RESPONSE"));
});

test("result limits and score thresholds are retained even for an incorrectly ordered SDK response", async () => {
  const fake = fakeQdrant();
  fake.client.query = async () => ({ points: [0.2, 0.95, 0.8].map((score, index) => ({ score, payload: embeddedChunk(index) })) });
  const results = await searchVectors([1, 0, 0], { connection: fake.connection, limit: 1, minScore: 0.5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 0.95);
});

test("cancellation stops awaiting the query and removes its abort listener", async () => {
  const fake = fakeQdrant();
  const cancelled = new AbortController();
  cancelled.abort("private reason");
  await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection, signal: cancelled.signal }), errorCode("CANCELLED"));
  assert.deepEqual(fake.calls, []);

  const active = new AbortController();
  let rejectQuery;
  fake.client.query = () => new Promise((_resolve, reject) => { rejectQuery = reject; });
  const pending = searchVectors([1, 0, 0], { connection: fake.connection, signal: active.signal });
  active.abort("private reason");
  await assert.rejects(pending, errorCode("CANCELLED"));
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  rejectQuery(new Error("private late error"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("successful searches clean up cancellation listeners and browser access is rejected", async () => {
  const fake = fakeQdrant();
  const controller = new AbortController();
  assert.deepEqual(await searchVectors([1, 0, 0], { connection: fake.connection, signal: controller.signal }), []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    await assert.rejects(searchVectors([1, 0, 0], { connection: fake.connection }), errorCode("CONFIGURATION_ERROR"));
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
});

test("the Step 6 cloud connection and search API share the configured vector dimensions", async (t) => {
  process.env.QDRANT_URL = "https://unit.eu-central.aws.cloud.qdrant.io:6333";
  process.env.QDRANT_API_KEY = "fake-test-key";
  process.env.QDRANT_COLLECTION = "unit_documents";
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
  const connection = getQdrantConnection();
  const query = t.mock.method(connection.client, "query", async () => ({ points: [] }));
  assert.deepEqual(await searchVectors([1, 0, 0]), []);
  assert.equal(query.mock.callCount(), 1);
  assert.equal(query.mock.calls[0].arguments[0], "unit_documents");
});

test("sample PDF chunks retain exact text, original IDs, and physical pages after indexing and search", async () => {
  const filename = new URL("../data/documents/taskflow/03_API_Guide.pdf", import.meta.url);
  const before = await readFile(filename);
  const pages = await extractText(fileURLToPath(filename), "taskflow/03_API_Guide.pdf");
  const chunks = await splitText(pages);
  const target = chunks.find((chunk) => chunk.pageNumber === 3 && /60/u.test(chunk.text));
  assert.ok(target, "The Step 1 API sample contains the documented rate limit on page 3.");
  const fake = fakeQdrant();
  await storeEmbeddings(chunks.map((chunk) => ({ ...chunk, embedding: chunk.id === target.id ? [1, 0, 0] : [0, 1, 0] })), { connection: fake.connection });
  const [found] = await searchVectors([1, 0, 0], { connection: fake.connection, limit: 1, minScore: 0.9 });
  assert.equal(found.chunkId, target.id);
  assert.equal(found.documentId, target.documentId);
  assert.equal(found.text, target.text);
  assert.equal(found.sourceName, "taskflow/03_API_Guide.pdf");
  assert.equal(found.page, 3);
  assert.equal(found.pageNumber, 3);
  assert.deepEqual(await readFile(filename), before);
});
