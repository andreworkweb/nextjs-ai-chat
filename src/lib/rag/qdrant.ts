import { QdrantClient } from "@qdrant/js-client-rest";
import type { Schemas } from "@qdrant/js-client-rest";
import { env } from "node:process";

export type QdrantErrorCode = "CONFIGURATION_ERROR" | "CONNECTION_ERROR"
  | "COLLECTION_MISMATCH" | "INVALID_INPUT" | "WRITE_FAILED" | "VERIFICATION_FAILED";

/** Contains no credentials, provider response bodies, or raw transport causes. */
export class QdrantStorageError extends Error {
  readonly code: QdrantErrorCode;
  readonly status?: number;

  constructor(code: QdrantErrorCode, message: string, status?: number) {
    super(message);
    this.name = "QdrantStorageError";
    this.code = code;
    this.status = status;
  }
}

export interface QdrantConnection {
  client: Pick<QdrantClient, "getCollection" | "createCollection" | "createPayloadIndex"
    | "upsert" | "retrieve" | "delete" | "count">;
  collection: string;
  dimensions: number;
}

let cached: { url: string; apiKey: string; client: QdrantClient } | undefined;

function settings() {
  if (typeof window !== "undefined") {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "Qdrant is only available on the Node.js server.");
  }
  const rawUrl = env.QDRANT_URL?.trim();
  const apiKey = env.QDRANT_API_KEY?.trim();
  const collection = env.QDRANT_COLLECTION?.trim();
  if (!rawUrl) throw new QdrantStorageError("CONFIGURATION_ERROR", "QDRANT_URL is required. Set the Qdrant Cloud cluster URL in the server environment.");
  if (!apiKey || !/^[!-~]+$/u.test(apiKey)) {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "QDRANT_API_KEY is required and must contain a valid server-side API key.");
  }
  if (!collection || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/u.test(collection)) {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "QDRANT_COLLECTION is required and must be a valid collection name.");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "QDRANT_URL must be a valid Qdrant Cloud HTTPS URL.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cloud.qdrant.io")
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "QDRANT_URL must be an HTTPS cluster URL ending in .cloud.qdrant.io, without credentials, query parameters, or a path.");
  }
  // Read the existing embedding dimension setting without changing it or the model.
  const rawDimensions = env.RAG_EMBEDDING_DIMENSIONS;
  const dimensions = rawDimensions === undefined ? 1024
    : /^\d+$/u.test(rawDimensions.trim()) ? Number(rawDimensions) : NaN;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65_536) {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "The existing embedding dimensions must be an integer between 1 and 65536.");
  }
  return { url, apiKey, collection, dimensions };
}

/** Lazy, reusable SDK client for ingestion and Next.js Node.js backend routes. */
export function getQdrantClient(): QdrantClient {
  const config = settings();
  const url = config.url.origin;
  if (!cached || cached.url !== url || cached.apiKey !== config.apiKey) {
    const client = new QdrantClient({
      url, apiKey: config.apiKey, port: config.url.port ? Number(config.url.port) : 443,
      timeout: 30_000, maxConnections: 4, checkCompatibility: false,
    });
    cached = { url, apiKey: config.apiKey, client };
  }
  return cached.client;
}

export function getQdrantConnection(): QdrantConnection {
  const config = settings();
  return { client: getQdrantClient(), collection: config.collection, dimensions: config.dimensions };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export async function qdrantOperation<T>(
  operation: () => Promise<T>,
  code: QdrantErrorCode,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof QdrantStorageError) throw error;
    throw new QdrantStorageError(code, message, statusOf(error));
  }
}

/** Never recreates or deletes an existing collection when its settings differ. */
export async function ensureQdrantCollection(connection = getQdrantConnection()): Promise<void> {
  const { client, collection, dimensions } = connection;
  let info: Schemas["CollectionInfo"];
  try {
    info = await client.getCollection(collection);
  } catch (error) {
    if (statusOf(error) !== 404) {
      throw new QdrantStorageError("CONNECTION_ERROR", "Unable to access Qdrant Cloud. Check the cluster URL, key, permissions, and network access.", statusOf(error));
    }
    try {
      await client.createCollection(collection, { vectors: { size: dimensions, distance: "Cosine" } });
    } catch (creationError) {
      // A concurrent creator may have completed between the read and create.
      if (statusOf(creationError) !== 409) {
        throw new QdrantStorageError("WRITE_FAILED", "Unable to create the Qdrant collection. Check cloud permissions and collection limits.", statusOf(creationError));
      }
    }
    info = await qdrantOperation(() => client.getCollection(collection), "CONNECTION_ERROR", "Unable to verify the Qdrant collection after creation.");
  }
  const vectors = info.config.params.vectors;
  if (!vectors || typeof vectors.size !== "number" || vectors.size !== dimensions || vectors.distance !== "Cosine") {
    throw new QdrantStorageError("COLLECTION_MISMATCH", `The Qdrant collection must use one unnamed ${dimensions}-dimensional Cosine vector. Existing data was not recreated.`);
  }
  // Qdrant Cloud strict mode requires indexes for fields used by cleanup filters.
  for (const field of ["sourceName", "documentId", "ingestionRevision"]) {
    const index = info.payload_schema[field];
    if (index && index.data_type !== "keyword") {
      throw new QdrantStorageError("COLLECTION_MISMATCH", `The Qdrant payload index ${field} must use keyword values.`);
    }
    if (!index) {
      await qdrantOperation(
        () => client.createPayloadIndex(collection, { field_name: field, field_schema: "keyword", wait: true }),
        "WRITE_FAILED", "Unable to create Qdrant payload indexes. Check collection write permissions.",
      );
    }
  }
}
