import { clearTimeout, setTimeout } from "node:timers";
import type { RerankedChunk, VectorSearchResult } from "./types.ts";

const RERANK_URL = "https://api.cohere.com/v2/rerank";
const DEFAULT_MODEL = "rerank-v5.0-fast";

export interface RerankChunksOptions {
  /** Defaults to RAG_RERANK_ENABLED=false. Never set from browser request data. */
  enabled?: boolean;
  /** Defaults to RAG_RERANK_TOP_N=5; applied only after successful reranking. */
  topN?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function cancelled(): never {
  throw new DOMException("Reranking was cancelled.", "AbortError");
}

function integerSetting(raw: string | undefined, fallback: number): number {
  return raw === undefined ? fallback : /^\d+$/u.test(raw.trim()) ? Number(raw) : NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rankedResults<T extends VectorSearchResult>(
  payload: unknown,
  original: readonly T[],
  count: number,
): Array<T & RerankedChunk> | null {
  if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length !== count) return null;
  const seen = new Set<number>();
  const ranks: { index: number; relevance: number }[] = [];
  for (const item of payload.results) {
    if (!isRecord(item) || typeof item.index !== "number" || !Number.isSafeInteger(item.index)
      || item.index < 0 || item.index >= original.length || seen.has(item.index)
      || typeof item.relevance_score !== "number" || !Number.isFinite(item.relevance_score)
      || item.relevance_score < 0 || item.relevance_score > 1) return null;
    seen.add(item.index);
    ranks.push({ index: item.index, relevance: item.relevance_score });
  }
  return ranks.sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .map(({ index, relevance }) => ({ ...original[index], rerankScore: relevance }));
}

/**
 * Optional Node.js reranking. Disabled or unavailable reranking returns every
 * original hit in vector-search order, without adding or inventing scores.
 * Caller cancellation is propagated; provider/configuration failures fall back.
 */
export async function rerankChunks<T extends VectorSearchResult>(
  question: string,
  chunks: readonly T[],
  options: RerankChunksOptions = {},
): Promise<Array<T & RerankedChunk>> {
  if (typeof window !== "undefined") {
    throw new Error("Reranking is only available on the Node.js server.");
  }
  if (typeof question !== "string" || !question.trim() || !Array.isArray(chunks)) {
    throw new TypeError("Reranking requires a non-empty question and an array of search results.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)
    || (options.enabled !== undefined && typeof options.enabled !== "boolean")
    || (options.fetch !== undefined && typeof options.fetch !== "function")
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw new TypeError("Invalid reranking options.");
  }
  for (const chunk of chunks) {
    if (!chunk || typeof chunk.text !== "string" || !chunk.text.trim()
      || typeof chunk.chunkId !== "string" || !chunk.chunkId.trim()
      || typeof chunk.documentId !== "string" || !chunk.documentId.trim()
      || typeof chunk.sourceName !== "string" || !chunk.sourceName.trim()
      || !Number.isSafeInteger(chunk.pageNumber) || chunk.pageNumber < 1 || chunk.page !== chunk.pageNumber
      || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0
      || typeof chunk.score !== "number" || !Number.isFinite(chunk.score)) {
      throw new TypeError("Reranking requires valid search text, source metadata, and vector scores.");
    }
  }
  if (options.signal?.aborted) cancelled();
  const original = [...chunks];
  const enabled = options.enabled ?? (process.env.RAG_RERANK_ENABLED?.trim().toLowerCase() === "true");
  if (!enabled || !original.length) return original;

  const apiKey = process.env.COHERE_API_KEY?.trim();
  const model = process.env.RAG_RERANK_MODEL?.trim() ?? DEFAULT_MODEL;
  const topN = options.topN !== undefined ? options.topN : integerSetting(process.env.RAG_RERANK_TOP_N, 5);
  const timeoutMs = integerSetting(process.env.RAG_RERANK_TIMEOUT_MS, 10_000);
  if (!apiKey || !/^[!-~]+$/u.test(apiKey) || !model || /\s/u.test(model)
    || !Number.isSafeInteger(topN) || topN < 1 || topN > 100
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || original.length > 1000) return original;

  const count = Math.min(topN, original.length);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(RERANK_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
      redirect: "error",
      signal,
      body: JSON.stringify({ model, query: question, documents: original.map((chunk) => chunk.text), top_n: count }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (options.signal?.aborted) cancelled();
      return original;
    }
    const payload: unknown = await response.json();
    if (options.signal?.aborted) cancelled();
    if (controller.signal.aborted) return original;
    return rankedResults(payload, original, count) ?? original;
  } catch {
    if (options.signal?.aborted) cancelled();
    // Do not expose or log provider bodies, credentials, query text, or passages.
    return original;
  } finally {
    clearTimeout(timer);
  }
}
