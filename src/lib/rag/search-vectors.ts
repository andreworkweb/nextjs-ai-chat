import type { Schemas } from "@qdrant/js-client-rest";
import { getQdrantConnection, qdrantOperation, QdrantStorageError } from "./qdrant.ts";
import type { QdrantConnection } from "./qdrant.ts";
import type { VectorSearchResult } from "./types.ts";

export type { VectorSearchResult } from "./types.ts";

export interface SearchMetadataFilter {
  /** Derive document access from trusted server-side authorization, not the browser. */
  documentIds?: readonly string[];
  sourceNames?: readonly string[];
}

export interface SearchVectorsOptions {
  /** Defaults to RAG_SEARCH_LIMIT or 10; bounded to 1–100. */
  limit?: number;
  /** Optional minimum Cosine similarity, from -1 to 1. */
  minScore?: number;
  /** All supplied fields must match. An empty array permits no documents. */
  filter?: SearchMetadataFilter;
  connection?: QdrantConnection;
  signal?: AbortSignal;
}

function invalidInput(message: string): never {
  throw new QdrantStorageError("INVALID_INPUT", message);
}

function invalidResponse(): never {
  throw new QdrantStorageError("INVALID_RESPONSE", "Qdrant returned invalid search scores or source metadata.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchSettings(options: SearchVectorsOptions) {
  const rawLimit = process.env.RAG_SEARCH_LIMIT;
  const limit = options.limit !== undefined ? options.limit
    : rawLimit === undefined ? 10 : /^\d+$/u.test(rawLimit.trim()) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new QdrantStorageError(options.limit !== undefined ? "INVALID_INPUT" : "CONFIGURATION_ERROR",
      "Search limit must be an integer between 1 and 100.");
  }
  const rawScore = process.env.RAG_SEARCH_MIN_SCORE;
  const minScore = options.minScore !== undefined ? options.minScore
    : rawScore === undefined ? undefined : rawScore.trim() ? Number(rawScore) : NaN;
  if (minScore !== undefined && (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)) {
    throw new QdrantStorageError(options.minScore !== undefined ? "INVALID_INPUT" : "CONFIGURATION_ERROR",
      "Search minScore must be a finite number between -1 and 1.");
  }
  return { limit, minScore };
}

function metadataFilter(filter: SearchMetadataFilter | undefined) {
  if (filter === undefined) return { conditions: [], documentIds: undefined, sourceNames: undefined, denyAll: false };
  if (!isRecord(filter) || (Object.getPrototypeOf(filter) !== Object.prototype && Object.getPrototypeOf(filter) !== null)
    || Object.keys(filter).some((key) => key !== "documentIds" && key !== "sourceNames")) {
    invalidInput("Search filter must contain only documentIds and sourceNames arrays.");
  }
  const conditions: Schemas["FieldCondition"][] = [];
  const restrictions: SearchMetadataFilter = {};
  let denyAll = false;
  for (const [name, key] of [["documentIds", "documentId"], ["sourceNames", "sourceName"]] as const) {
    const values = filter[name];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 1000
      || !Array.from(values).every((value: unknown) => typeof value === "string" && !!value.trim())) {
      invalidInput("Metadata filters must be arrays of at most 1000 non-empty strings.");
    }
    if (!values.length) denyAll = true;
    const identifiers: string[] = [...new Set(values)];
    restrictions[name] = identifiers;
    conditions.push({ key, match: { any: identifiers } });
  }
  return {
    conditions, denyAll,
    documentIds: restrictions.documentIds,
    sourceNames: restrictions.sourceNames,
  };
}

async function queryPoints(connection: QdrantConnection, request: Schemas["QueryRequest"], signal?: AbortSignal) {
  const operation = qdrantOperation(
    () => connection.client.query(connection.collection, request),
    "SEARCH_FAILED", "Unable to search Qdrant Cloud. Check collection access, dimensions, and network availability.",
  );
  if (!signal) return operation;
  let onAbort: () => void = () => {};
  try {
    // The SDK owns its 30-second network timeout. Stop awaiting promptly on abort;
    // Promise.race also observes a later SDK rejection, avoiding unhandled errors.
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new QdrantStorageError("CANCELLED", "Vector search was cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Search the existing cloud collection without generating answers or writing data. */
export async function searchVectors(
  queryEmbedding: readonly number[],
  options: SearchVectorsOptions = {},
): Promise<VectorSearchResult[]> {
  if (typeof window !== "undefined") {
    throw new QdrantStorageError("CONFIGURATION_ERROR", "Vector search is only available on the Node.js server.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    invalidInput("Invalid vector search options.");
  }
  if (!Array.isArray(queryEmbedding) || !queryEmbedding.length
    || !Array.from(queryEmbedding).every((value: unknown) => typeof value === "number" && Number.isFinite(value))
    || !queryEmbedding.some((value) => value !== 0)) {
    invalidInput("Query embedding must be a non-empty, finite, non-zero numerical vector.");
  }
  if (options.signal?.aborted) throw new QdrantStorageError("CANCELLED", "Vector search was cancelled.");
  const { limit, minScore } = searchSettings(options);
  const filter = metadataFilter(options.filter);
  if (filter.denyAll) return [];
  const connection = options.connection ?? getQdrantConnection();
  if (queryEmbedding.length !== connection.dimensions) {
    invalidInput("Query embedding dimensions must match the configured ingestion dimensions.");
  }

  const response = await queryPoints(connection, {
    query: [...queryEmbedding], limit,
    with_payload: ["text", "sourceName", "pageNumber", "documentId", "id", "chunkIndex"],
    with_vector: false,
    ...(minScore !== undefined ? { score_threshold: minScore } : {}),
    ...(filter.conditions.length ? { filter: { must: filter.conditions } } : {}),
  }, options.signal);
  if (options.signal?.aborted) throw new QdrantStorageError("CANCELLED", "Vector search was cancelled.");
  if (!isRecord(response) || !Array.isArray(response.points)) invalidResponse();
  const results = response.points.map((point: unknown): VectorSearchResult => {
    if (!isRecord(point) || typeof point.score !== "number" || !Number.isFinite(point.score) || !isRecord(point.payload)) {
      invalidResponse();
    }
    const payload = point.payload;
    for (const field of ["text", "sourceName", "documentId", "id"] as const) {
      if (typeof payload[field] !== "string" || !payload[field].trim()) invalidResponse();
    }
    if (typeof payload.pageNumber !== "number" || !Number.isSafeInteger(payload.pageNumber) || payload.pageNumber < 1
      || typeof payload.chunkIndex !== "number" || !Number.isSafeInteger(payload.chunkIndex) || payload.chunkIndex < 0) {
      invalidResponse();
    }
    if ((filter.documentIds && !filter.documentIds.includes(payload.documentId as string))
      || (filter.sourceNames && !filter.sourceNames.includes(payload.sourceName as string))) invalidResponse();
    return {
      text: payload.text as string, sourceName: payload.sourceName as string,
      documentId: payload.documentId as string, chunkId: payload.id as string,
      page: payload.pageNumber, pageNumber: payload.pageNumber, chunkIndex: payload.chunkIndex,
      score: point.score,
    };
  });
  return results.filter((result) => minScore === undefined || result.score >= minScore)
    .sort((left, right) => right.score - left.score).slice(0, limit);
}
