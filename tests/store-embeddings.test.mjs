import assert from "node:assert/strict";
import { test } from "node:test";
import { storeEmbeddings } from "../src/lib/rag/store-embeddings.ts";
import { embeddedChunk, fakeQdrant } from "./helpers/fake-qdrant.mjs";

test("points retain every source field and verified normalized vectors", async () => {
  const fake = fakeQdrant();
  const chunks = Object.freeze([Object.freeze(embeddedChunk(0, { section: "Introduction" })), Object.freeze(embeddedChunk(1, { pageNumber: 2 }))]);
  const snapshot = structuredClone(chunks);
  const result = await storeEmbeddings(chunks, { connection: fake.connection, batchSize: 1 });
  assert.deepEqual(result, [{ sourceName: "guide.txt", documentId: "document-version-one", chunks: 2, verified: 2 }]);
  assert.deepEqual(chunks, snapshot);
  assert.equal(fake.points.size, 2);
  for (const point of fake.points.values()) {
    assert.match(point.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const source = chunks.find((chunk) => chunk.id === point.payload.id);
    const { embedding, ...metadata } = source;
    assert.equal(point.vector.length, embedding.length);
    const { ingestionRevision, ...payload } = point.payload;
    assert.match(ingestionRevision, /^[0-9a-f]{64}$/);
    assert.deepEqual(payload, metadata);
  }
  assert.ok(fake.calls.filter((call) => call.method === "upsert").every((call) => call.args[1].wait === true));
  assert.ok(fake.calls.filter((call) => call.method === "retrieve").every((call) => call.args[1].with_vector && call.args[1].with_payload));
  assert.ok(fake.calls.findIndex((call) => call.method === "delete") > fake.calls.findLastIndex((call) => call.method === "retrieve"));
});

test("repeated ingestion is idempotent with deterministic point IDs", async () => {
  const fake = fakeQdrant();
  const chunks = [embeddedChunk(0), embeddedChunk(1), embeddedChunk(2)];
  await storeEmbeddings(chunks, { connection: fake.connection });
  const first = [...fake.points.entries()];
  await storeEmbeddings(chunks, { connection: fake.connection });
  assert.deepEqual([...fake.points.entries()], first);
});

test("updated documents and changed splitting replace previous revisions without stale chunks", async () => {
  const fake = fakeQdrant();
  await storeEmbeddings([embeddedChunk(0), embeddedChunk(1), embeddedChunk(2), embeddedChunk(7, { sourceName: "other.txt" })], { connection: fake.connection });
  const next = [embeddedChunk(10, { documentId: "new-content-hash", chunkIndex: 0 })];
  await storeEmbeddings(next, { connection: fake.connection });
  assert.equal(fake.points.size, 2);
  const current = [...fake.points.values()].find((point) => point.payload.sourceName === "guide.txt");
  assert.equal(current.payload.documentId, "new-content-hash");
  assert.equal(current.payload.id, next[0].id);
  await storeEmbeddings([embeddedChunk(11, { documentId: "new-content-hash" }), embeddedChunk(12, { documentId: "new-content-hash" })], { connection: fake.connection });
  assert.equal(fake.points.size, 3);
  assert.ok(!fake.points.has(current.id));
});

test("identical content in different source paths cannot overwrite each other", async () => {
  const fake = fakeQdrant();
  const same = embeddedChunk();
  await storeEmbeddings([same, { ...same, sourceName: "nested/guide.txt" }], { connection: fake.connection });
  assert.equal(fake.points.size, 2);
  assert.equal(new Set([...fake.points.values()].map((point) => point.payload.id)).size, 1);
  assert.equal(new Set([...fake.points.values()].map((point) => point.payload.sourceName)).size, 2);
});

test("a partial upsert failure preserves the previous revision and a later retry converges", async () => {
  const fake = fakeQdrant();
  await storeEmbeddings([embeddedChunk(0), embeddedChunk(1)], { connection: fake.connection });
  const oldIds = [...fake.points.keys()];
  const deletesBefore = fake.calls.filter((call) => call.method === "delete").length;
  const upsert = fake.client.upsert;
  let writes = 0;
  fake.client.upsert = async (...args) => {
    if (++writes === 2) throw new Error("private transport failure");
    return upsert(...args);
  };
  const next = [10, 11, 12].map((index) => embeddedChunk(index, { documentId: "new-version" }));
  await assert.rejects(storeEmbeddings(next, { connection: fake.connection, batchSize: 2 }), (error) => error.code === "WRITE_FAILED");
  assert.ok(oldIds.every((id) => fake.points.has(id)));
  assert.equal(fake.calls.filter((call) => call.method === "delete").length, deletesBefore);
  fake.client.upsert = upsert;
  await storeEmbeddings(next, { connection: fake.connection, batchSize: 2 });
  assert.equal(fake.points.size, 3);
  assert.ok(oldIds.every((id) => !fake.points.has(id)));
});

test("payload and vector verification failures do not delete the previous source revision", async () => {
  for (const corrupt of [
    (point) => { point.payload.text = "corrupted"; },
    (point) => { point.vector = [0, 1, 0]; },
    (point) => { point.vector = [1, 2]; },
  ]) {
    const fake = fakeQdrant();
    await storeEmbeddings([embeddedChunk()], { connection: fake.connection });
    const oldId = [...fake.points.keys()][0];
    const deletes = fake.calls.filter((call) => call.method === "delete").length;
    const retrieve = fake.client.retrieve;
    fake.client.retrieve = async (...args) => {
      const points = await retrieve(...args);
      corrupt(points[0]);
      return points;
    };
    await assert.rejects(storeEmbeddings([embeddedChunk(10, { documentId: "next" })], { connection: fake.connection }), (error) => error.code === "VERIFICATION_FAILED");
    assert.ok(fake.points.has(oldId));
    assert.equal(fake.calls.filter((call) => call.method === "delete").length, deletes);
  }
});

test("missing retrieval results, failed cleanup, and incorrect final counts cannot report success", async () => {
  const missing = fakeQdrant();
  missing.client.retrieve = async () => [];
  await assert.rejects(storeEmbeddings([embeddedChunk()], { connection: missing.connection }), (error) => error.code === "VERIFICATION_FAILED");
  assert.ok(!missing.calls.some((call) => call.method === "delete"));
  const cleanup = fakeQdrant();
  cleanup.client.delete = async () => { throw Object.assign(new Error("secret-key private contents"), { status: 503 }); };
  await assert.rejects(storeEmbeddings([embeddedChunk()], { connection: cleanup.connection }), (error) => {
    assert.equal(error.code, "WRITE_FAILED");
    assert.equal(error.status, 503);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes("secret-key"));
    return true;
  });
  const count = fakeQdrant();
  count.client.count = async () => ({ count: 99 });
  await assert.rejects(storeEmbeddings([embeddedChunk()], { connection: count.connection }), (error) => error.code === "VERIFICATION_FAILED");
});

test("invalid vectors and mixed source versions fail before any cloud writes", async () => {
  for (const input of [
    [embeddedChunk(0, { embedding: [1, 2] })], [embeddedChunk(0, { embedding: [NaN, 0, 0] })],
    [embeddedChunk(0, { embedding: [Infinity, 0, 0] })], [embeddedChunk(0, { text: "" })],
    [embeddedChunk(0, { pageNumber: 0 })], [embeddedChunk(), embeddedChunk()],
    [embeddedChunk(), embeddedChunk(1, { documentId: "different-version" })],
  ]) {
    const fake = fakeQdrant();
    await assert.rejects(storeEmbeddings(input, { connection: fake.connection }), (error) => error.code === "INVALID_INPUT");
    assert.equal(fake.calls.length, 0);
  }
  assert.deepEqual(await storeEmbeddings([]), []);
  await assert.rejects(storeEmbeddings(null), (error) => error.code === "INVALID_INPUT");
  await assert.rejects(storeEmbeddings([embeddedChunk()], { batchSize: 0 }), /batchSize/);
});
