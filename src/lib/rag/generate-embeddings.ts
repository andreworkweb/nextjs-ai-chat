import { setTimeout as delay } from "node:timers/promises";
import type { Chunk, EmbeddedChunk } from "./types";

const EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "liquid/lfm-2.5-embedding-350m:free";
const RETRY_BASE_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

export type EmbeddingErrorCode =
  | "INVALID_INPUT"
  | "CONFIGURATION_ERROR"
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "REQUEST_REJECTED"
  | "PROVIDER_ERROR"
  | "REQUEST_TIMEOUT"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "CANCELLED";

/** Safe to report: never contains provider response bodies or transport causes. */
export class EmbeddingGenerationError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: EmbeddingErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "EmbeddingGenerationError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface GenerateEmbeddingsOptions {
  /** Injectable transports let unit tests run without network access. */
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : /^\d+$/u.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EmbeddingGenerationError(
      "CONFIGURATION_ERROR",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedVectors(payload: unknown, count: number, dimensions: number): number[][] {
  const invalidResponse = () => new EmbeddingGenerationError(
    "INVALID_RESPONSE", "The embedding service returned invalid or incomplete vectors.",
  );
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== count) {
    throw invalidResponse();
  }

  const vectors: number[][] = new Array(count);
  const seen = new Set<number>();
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.index !== "number" || !Number.isSafeInteger(item.index)
      || item.index < 0 || item.index >= count || seen.has(item.index)) {
      throw invalidResponse();
    }
    const vector: unknown = item.embedding;
    if (!Array.isArray(vector) || vector.length !== dimensions
      || !vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
      throw invalidResponse();
    }
    seen.add(item.index);
    vectors[item.index] = [...vector];
  }
  return vectors;
}

function retryAfterMilliseconds(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  const seconds = Number(header);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function httpError(response: Response): EmbeddingGenerationError {
  const status = response.status;
  const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"));
  if (status === 401 || status === 403) {
    return new EmbeddingGenerationError("AUTHENTICATION_FAILED", "Embedding authentication failed. Check the server API key and provider permissions.", status);
  }
  if (status === 429) {
    return new EmbeddingGenerationError("RATE_LIMITED", "The embedding service is rate limited. Try again later.", status, retryAfter);
  }
  if (status === 408) {
    return new EmbeddingGenerationError("REQUEST_TIMEOUT", "The embedding service timed out. Try again later.", status, retryAfter);
  }
  if (status >= 500 && status <= 599) {
    return new EmbeddingGenerationError("PROVIDER_ERROR", "The embedding service is temporarily unavailable. Try again later.", status, retryAfter);
  }
  return new EmbeddingGenerationError(
    "REQUEST_REJECTED",
    "The embedding service rejected the request. Check the configured model, input token limit, and account access.",
    status,
  );
}

function cancelled(): EmbeddingGenerationError {
  return new EmbeddingGenerationError("CANCELLED", "Embedding generation was cancelled.");
}

function retryable(error: EmbeddingGenerationError): boolean {
  return error.code === "RATE_LIMITED" || error.code === "REQUEST_TIMEOUT"
    || error.code === "NETWORK_ERROR" || error.code === "PROVIDER_ERROR";
}

/**
 * Node.js server only. Reads OPENROUTER_API_KEY and RAG_EMBEDDING_* settings at
 * call time. Shared transport for complete document and query texts.
 * No storage, logging, model fallback, or partial results are performed here.
 */
export async function embedTexts(
  texts: readonly string[],
  options: GenerateEmbeddingsOptions = {},
): Promise<number[][]> {
  if (typeof window !== "undefined") {
    throw new EmbeddingGenerationError("CONFIGURATION_ERROR", "Embedding generation is only available on the Node.js server.");
  }
  if (!Array.isArray(texts)) {
    throw new EmbeddingGenerationError("INVALID_INPUT", "Expected an array of non-empty text strings.");
  }
  const input: readonly string[] = texts;
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.fetch !== undefined && typeof options.fetch !== "function")
    || (options.sleep !== undefined && typeof options.sleep !== "function")
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new EmbeddingGenerationError("INVALID_INPUT", "Invalid embedding transport options.");
  }
  for (const [index, text] of input.entries()) {
    if (typeof text !== "string" || !text.trim()) {
      throw new EmbeddingGenerationError("INVALID_INPUT", `Text at index ${index} must be a non-empty string.`);
    }
  }
  if (input.length === 0) return [];
  if (options.signal?.aborted) throw cancelled();

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.RAG_EMBEDDING_MODEL?.trim() ?? DEFAULT_MODEL;
  if (!apiKey || /\s/u.test(apiKey)) {
    throw new EmbeddingGenerationError("CONFIGURATION_ERROR", "OPENROUTER_API_KEY must be configured on the server.");
  }
  if (!model || /\s/u.test(model)) {
    throw new EmbeddingGenerationError("CONFIGURATION_ERROR", "RAG_EMBEDDING_MODEL must contain a valid model ID.");
  }
  const dimensions = integerSetting("RAG_EMBEDDING_DIMENSIONS", 1024, 1, 65_536);
  const batchSize = integerSetting("RAG_EMBEDDING_BATCH_SIZE", 16, 1, 128);
  const timeoutMs = integerSetting("RAG_EMBEDDING_TIMEOUT_MS", 30_000, 1, 120_000);
  const maxRetries = integerSetting("RAG_EMBEDDING_MAX_RETRIES", 3, 0, 5);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => delay(milliseconds, undefined, { signal }));

  async function embedBatch(batch: readonly string[]): Promise<number[][]> {
    const body = JSON.stringify({ model, input: batch, encoding_format: "float" });
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw cancelled();
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure: EmbeddingGenerationError;
      try {
        const response = await fetchImplementation(EMBEDDINGS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
          cache: "no-store",
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          const error = httpError(response);
          await response.body?.cancel().catch(() => {});
          throw error;
        }
        const payload: unknown = await response.json();
        if (options.signal?.aborted) throw cancelled();
        if (controller.signal.aborted) {
          throw new EmbeddingGenerationError("REQUEST_TIMEOUT", "The embedding service took too long to respond.");
        }
        return validatedVectors(payload, batch.length, dimensions);
      } catch (error) {
        if (options.signal?.aborted) throw cancelled();
        if (controller.signal.aborted) {
          failure = new EmbeddingGenerationError("REQUEST_TIMEOUT", "The embedding service took too long to respond.");
        } else if (error instanceof EmbeddingGenerationError) {
          failure = error;
        } else if (error instanceof SyntaxError) {
          failure = new EmbeddingGenerationError("INVALID_RESPONSE", "The embedding service returned invalid JSON.");
        } else {
          // Transport exceptions can contain headers, request text, or credentials.
          failure = new EmbeddingGenerationError("NETWORK_ERROR", "The embedding service could not be reached.");
        }
      } finally {
        clearTimeout(timer);
      }

      if (!retryable(failure) || attempt >= maxRetries) throw failure;
      const waitMs = Math.max(Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_DELAY_MS), failure.retryAfterMs ?? 0);
      // Do not retry earlier than a provider's long Retry-After to meet our bound.
      if (waitMs > MAX_RETRY_DELAY_MS) throw failure;
      try {
        await sleep(waitMs, options.signal);
      } catch {
        if (options.signal?.aborted) throw cancelled();
        throw new EmbeddingGenerationError("NETWORK_ERROR", "Unable to wait for an embedding retry.");
      }
    }
  }

  const results: number[][] = [];
  for (let offset = 0; offset < input.length; offset += batchSize) {
    const batch = input.slice(offset, offset + batchSize);
    results.push(...await embedBatch(batch));
  }
  return results;
}

/** Embed document chunks with the shared text transport, retaining all metadata. */
export async function generateEmbeddings(
  chunks: readonly Chunk[],
  options: GenerateEmbeddingsOptions = {},
): Promise<EmbeddedChunk[]> {
  if (typeof window !== "undefined") {
    throw new EmbeddingGenerationError("CONFIGURATION_ERROR", "Embedding generation is only available on the Node.js server.");
  }
  if (!Array.isArray(chunks)) {
    throw new EmbeddingGenerationError("INVALID_INPUT", "Expected an array of Chunk objects.");
  }
  for (const [index, chunk] of chunks.entries()) {
    if (!chunk || typeof chunk.id !== "string" || !chunk.id.trim()
      || typeof chunk.documentId !== "string" || !chunk.documentId.trim()
      || typeof chunk.sourceName !== "string" || !chunk.sourceName.trim()
      || typeof chunk.text !== "string" || !chunk.text.trim()
      || !Number.isSafeInteger(chunk.pageNumber) || chunk.pageNumber < 1
      || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
      throw new EmbeddingGenerationError("INVALID_INPUT", `Chunk at index ${index} requires non-empty text, IDs, sourceName, and valid page and chunk numbers.`);
    }
  }
  const vectors = await embedTexts(chunks.map((chunk) => chunk.text), options);
  return chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] }));
}
