import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Schemas } from "@qdrant/js-client-rest";
import { ensureQdrantCollection, getQdrantConnection, qdrantOperation, QdrantStorageError } from "./qdrant.ts";
import type { QdrantConnection } from "./qdrant.ts";
import type { EmbeddedChunk } from "./types";

export interface StoreEmbeddingsOptions {
  connection?: QdrantConnection;
  batchSize?: number;
}

export interface StoredDocument {
  sourceName: string;
  documentId: string;
  chunks: number;
  verified: number;
}

function scopedPointId(sourceName: string, chunkId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["qdrant-source-v1", sourceName, chunkId])).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function matchesCosineVector(actual: unknown, expected: number[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || !actual.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) return false;
  // Cosine collections normalize vectors on upload; compare their directions.
  const scale = expected.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (scale === 0) return actual.every((value) => value === 0);
  const scaled = expected.map((value) => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return actual.every((value, index) => Math.abs(value - scaled[index] / norm) < 0.0001);
}

/**
 * Replace each supplied source after writing and verifying all its new points.
 * sourceName is the stable relative file path, independent of content hashes.
 * Run one ingestion writer at a time. Existing unrelated sources are preserved.
 */
export async function storeEmbeddings(
  chunks: readonly EmbeddedChunk[],
  options: StoreEmbeddingsOptions = {},
): Promise<StoredDocument[]> {
  if (typeof window !== "undefined") throw new QdrantStorageError("CONFIGURATION_ERROR", "Qdrant storage is only available on the Node.js server.");
  if (!Array.isArray(chunks) || !options || typeof options !== "object" || Array.isArray(options)) {
    throw new QdrantStorageError("INVALID_INPUT", "Expected EmbeddedChunk objects and valid storage options.");
  }
  const input: readonly EmbeddedChunk[] = chunks;
  const batchSize = options.batchSize ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new QdrantStorageError("INVALID_INPUT", "Storage batchSize must be an integer between 1 and 256.");
  }
  if (!input.length) return [];
  const connection = options.connection ?? getQdrantConnection();
  const groups = new Map<string, EmbeddedChunk[]>();
  for (const [index, chunk] of input.entries()) {
    if (!chunk || typeof chunk.id !== "string" || !chunk.id.trim()
      || typeof chunk.documentId !== "string" || !chunk.documentId.trim()
      || typeof chunk.sourceName !== "string" || !chunk.sourceName.trim()
      || typeof chunk.text !== "string" || !chunk.text.trim()
      || !Number.isSafeInteger(chunk.pageNumber) || chunk.pageNumber < 1
      || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0
      || !Array.isArray(chunk.embedding) || chunk.embedding.length !== connection.dimensions
      || !Array.from(chunk.embedding).every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
      throw new QdrantStorageError("INVALID_INPUT", `EmbeddedChunk at index ${index} has invalid metadata or vector dimensions/values.`);
    }
    const group = groups.get(chunk.sourceName) ?? [];
    if (group.length && (group[0].documentId !== chunk.documentId || group.some((entry) => entry.id === chunk.id))) {
      throw new QdrantStorageError("INVALID_INPUT", "Each source must have one document version and unique chunk IDs per ingestion.");
    }
    group.push(chunk);
    groups.set(chunk.sourceName, group);
  }

  await ensureQdrantCollection(connection);
  const { client, collection } = connection;
  const results: StoredDocument[] = [];
  for (const [sourceName, group] of groups) {
    const ingestionRevision = createHash("sha256").update(JSON.stringify(group.map((chunk) => chunk.id).sort())).digest("hex");
    const points = group.map((chunk) => {
      const { embedding, ...metadata } = chunk;
      return {
        id: scopedPointId(sourceName, chunk.id), vector: embedding,
        payload: { ...metadata, ingestionRevision },
      };
    });
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize);
      await qdrantOperation(() => client.upsert(collection, { points: batch, wait: true }), "WRITE_FAILED", "Unable to store Qdrant points. Existing source revisions were retained.");
    }
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize);
      const retrieved = await qdrantOperation(
        () => client.retrieve(collection, { ids: batch.map((point) => point.id), with_payload: true, with_vector: true }),
        "VERIFICATION_FAILED", "Unable to retrieve the stored Qdrant points. Existing source revisions were retained.",
      );
      const byId = new Map(retrieved.map((point) => [String(point.id), point]));
      if (retrieved.length !== batch.length || byId.size !== batch.length || batch.some((point) => {
        const stored = byId.get(point.id);
        return !stored || !isDeepStrictEqual(stored.payload, point.payload) || !matchesCosineVector(stored.vector, point.vector);
      })) {
        throw new QdrantStorageError("VERIFICATION_FAILED", "Stored Qdrant vectors or payloads did not match the source. Existing source revisions were retained.");
      }
    }
    const sourceFilter: Schemas["Filter"] = { must: [{ key: "sourceName", match: { value: sourceName } }] };
    // Only retire old revisions after every new point has been retrieved intact.
    await qdrantOperation(() => client.delete(collection, {
      wait: true,
      filter: { ...sourceFilter, must_not: [{ key: "ingestionRevision", match: { value: ingestionRevision } }] },
    }), "WRITE_FAILED", "The new source was stored, but cleanup of its previous revision failed. Re-run ingestion safely.");
    const { count } = await qdrantOperation(
      () => client.count(collection, { filter: sourceFilter, exact: true }),
      "VERIFICATION_FAILED", "Unable to verify the final Qdrant source count.",
    );
    if (count !== points.length) {
      throw new QdrantStorageError("VERIFICATION_FAILED", "The final Qdrant source count was unexpected. Run one ingestion writer at a time and retry.");
    }
    results.push({ sourceName, documentId: group[0].documentId, chunks: points.length, verified: points.length });
  }
  return results;
}
