import { EmbeddingGenerationError, embedTexts } from "./generate-embeddings.ts";
import type { GenerateEmbeddingsOptions } from "./generate-embeddings.ts";

/**
 * Embed one question on the Node.js server, using the exact ingestion transport,
 * configuration, vector validation, and retry policy. Never truncates the input.
 */
export async function embedQuery(
  question: string,
  options: GenerateEmbeddingsOptions = {},
): Promise<number[]> {
  if (typeof question !== "string" || !question.trim()) {
    throw new EmbeddingGenerationError("INVALID_INPUT", "A non-empty question is required for query embedding.");
  }
  const [vector] = await embedTexts([question], options);
  return vector;
}
