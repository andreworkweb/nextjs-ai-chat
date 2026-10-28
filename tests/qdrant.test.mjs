import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { QdrantClient } from "@qdrant/js-client-rest";
import { ensureQdrantCollection, getQdrantClient, getQdrantConnection, QdrantStorageError } from "../src/lib/rag/qdrant.ts";
import { fakeQdrant } from "./helpers/fake-qdrant.mjs";

const names = ["QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION", "RAG_EMBEDDING_DIMENSIONS"];
const original = new Map(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  process.env.QDRANT_URL = "https://unit.eu-central.aws.cloud.qdrant.io:6333";
  process.env.QDRANT_API_KEY = "fake-qdrant-test-key";
  process.env.QDRANT_COLLECTION = "unit_documents";
  process.env.RAG_EMBEDDING_DIMENSIONS = "3";
});
afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("Qdrant configuration is lazy and the backend can reuse the full SDK client", (t) => {
  const network = t.mock.method(QdrantClient.prototype, "getCollection", async () => { throw new Error("Unexpected network call"); });
  const client = getQdrantClient();
  assert.equal(getQdrantClient(), client);
  assert.equal(getQdrantConnection().client, client);
  assert.equal(typeof client.query, "function");
  assert.equal(typeof client.scroll, "function");
  assert.equal(network.mock.callCount(), 0);
  assert.equal(getQdrantConnection().collection, "unit_documents");
  assert.equal(getQdrantConnection().dimensions, 3);
  delete process.env.RAG_EMBEDDING_DIMENSIONS;
  assert.equal(getQdrantConnection().dimensions, 1024);
});

test("missing credentials and invalid URLs fail without revealing values", () => {
  for (const name of ["QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION"]) {
    const saved = process.env[name];
    delete process.env[name];
    assert.throws(() => getQdrantConnection(), (error) => error instanceof QdrantStorageError && error.message.includes(name));
    process.env[name] = saved;
  }
  for (const url of ["invalid", "http://unit.cloud.qdrant.io", "https://localhost:6333", "https://example.com", "https://unit.cloud.qdrant.io/collections", "https://private:secret@unit.cloud.qdrant.io", "https://unit.cloud.qdrant.io?secret=private"]) {
    process.env.QDRANT_URL = url;
    assert.throws(() => getQdrantConnection(), (error) => {
      assert.equal(error.code, "CONFIGURATION_ERROR");
      assert.ok(!error.message.includes(url));
      assert.ok(!JSON.stringify(error).includes("fake-qdrant-test-key"));
      return true;
    });
  }
});

test("invalid collection names, keys, and existing dimension settings are rejected", () => {
  for (const [name, values] of [
    ["QDRANT_API_KEY", ["", " ", "secret\nkey"]],
    ["QDRANT_COLLECTION", ["", "bad/name", "name\nvalue"]],
    ["RAG_EMBEDDING_DIMENSIONS", ["", "1.5", "0", "65537", "not-a-number"]],
  ]) {
    const saved = process.env[name];
    for (const value of values) {
      process.env[name] = value;
      assert.throws(() => getQdrantConnection(), (error) => error.code === "CONFIGURATION_ERROR");
    }
    process.env[name] = saved;
  }
});

test("a missing cloud collection is created with matching dimensions and Cosine distance", async () => {
  const fake = fakeQdrant({ exists: false });
  await ensureQdrantCollection(fake.connection);
  assert.deepEqual(fake.calls.find((call) => call.method === "createCollection").args, ["unit_documents", { vectors: { size: 3, distance: "Cosine" } }]);
  assert.deepEqual(fake.calls.filter((call) => call.method === "createPayloadIndex").map((call) => call.args[1]), [
    { field_name: "sourceName", field_schema: "keyword", wait: true },
    { field_name: "documentId", field_schema: "keyword", wait: true },
    { field_name: "ingestionRevision", field_schema: "keyword", wait: true },
  ]);
});

test("an existing compatible collection and its indexes are reused", async () => {
  const fake = fakeQdrant();
  await ensureQdrantCollection(fake.connection);
  await ensureQdrantCollection(fake.connection);
  assert.equal(fake.calls.filter((call) => call.method === "createCollection").length, 0);
  assert.equal(fake.calls.filter((call) => call.method === "createPayloadIndex").length, 3);
});

test("dimension, distance, named-vector, and index mismatches never recreate existing data", async () => {
  for (const vectors of [{ size: 4, distance: "Cosine" }, { size: 3, distance: "Dot" }, { named: { size: 3, distance: "Cosine" } }]) {
    const fake = fakeQdrant();
    fake.info.config.params.vectors = vectors;
    await assert.rejects(ensureQdrantCollection(fake.connection), (error) => error.code === "COLLECTION_MISMATCH");
    assert.equal(fake.calls.length, 1);
  }
  const fake = fakeQdrant();
  fake.info.payload_schema.sourceName = { data_type: "text" };
  await assert.rejects(ensureQdrantCollection(fake.connection), /must use keyword/);
});

test("collection creation races are rechecked before use", async () => {
  const fake = fakeQdrant({ exists: false });
  const create = fake.client.createCollection;
  fake.client.createCollection = async (...args) => {
    await create(...args);
    throw Object.assign(new Error("Already exists"), { status: 409 });
  };
  await ensureQdrantCollection(fake.connection);
  assert.equal(fake.calls.filter((call) => call.method === "getCollection").length, 2);
});

test("cloud connection and write failures expose safe errors without raw causes", async () => {
  const fake = fakeQdrant();
  fake.client.getCollection = async () => { throw Object.assign(new Error("secret-api-key private response"), { status: 403 }); };
  await assert.rejects(ensureQdrantCollection(fake.connection), (error) => {
    assert.equal(error.code, "CONNECTION_ERROR");
    assert.equal(error.status, 403);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes("secret-api-key"));
    return true;
  });
  const missing = fakeQdrant({ exists: false });
  missing.client.createCollection = async () => { throw Object.assign(new Error("secret-api-key"), { status: 403 }); };
  await assert.rejects(ensureQdrantCollection(missing.connection), (error) => error.code === "WRITE_FAILED");
});

test("browser callers cannot obtain Qdrant credentials or clients", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    assert.throws(() => getQdrantClient(), /only available on the Node.js server/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});
