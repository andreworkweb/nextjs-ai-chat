import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureQdrantCollection, getQdrantClient, getQdrantConnection, qdrantOperation } from "../src/lib/rag/qdrant.ts";

const enabled = process.env.RUN_QDRANT_INTEGRATION === "1";
test("live Qdrant Cloud points retain source metadata and are retrievable and searchable", {
  skip: !enabled ? "Requires RUN_QDRANT_INTEGRATION=1 after npm run ingest." : false,
  timeout: 90_000,
}, async (t) => {
  const connection = getQdrantConnection();
  await ensureQdrantCollection(connection);
  const client = getQdrantClient();
  const read = (operation) => qdrantOperation(operation, "VERIFICATION_FAILED", "Unable to verify stored Qdrant Cloud data.");
  const { count } = await read(() => client.count(connection.collection, { exact: true }));
  assert.ok(count > 0, "Run npm run ingest before the live Qdrant test.");
  const { points } = await read(() => client.scroll(connection.collection, { limit: 1, with_payload: true, with_vector: true }));
  assert.equal(points.length, 1);
  const point = points[0];
  assert.ok(Array.isArray(point.vector));
  assert.equal(point.vector.length, connection.dimensions);
  assert.ok(point.vector.every((value) => typeof value === "number" && Number.isFinite(value)));
  for (const field of ["id", "documentId", "sourceName", "text", "ingestionRevision"]) {
    assert.ok(typeof point.payload[field] === "string" && point.payload[field].length > 0);
  }
  assert.ok(point.payload.pageNumber >= 1 && point.payload.chunkIndex >= 0);
  const retrieved = await read(() => client.retrieve(connection.collection, { ids: [point.id], with_payload: true }));
  assert.equal(retrieved.length, 1);
  assert.deepEqual(retrieved[0].payload, point.payload);
  const result = await read(() => client.query(connection.collection, { query: point.vector, limit: 1, with_payload: true }));
  assert.ok(result.points.length > 0 && result.points[0].score > 0.99);
  t.diagnostic(`Verified ${count} cloud points with ${connection.dimensions}-dimensional vectors and a successful similarity query.`);
});
