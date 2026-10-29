import { ChatQueryError, readChatQuery } from "../../../lib/rag/chat-request.ts";
import { embedQuery } from "../../../lib/rag/embed-query.ts";
import { EmbeddingGenerationError } from "../../../lib/rag/generate-embeddings.ts";
import { searchVectors } from "../../../lib/rag/search-vectors.ts";
import { QdrantStorageError } from "../../../lib/rag/qdrant.ts";
import { rerankChunks } from "../../../lib/rag/rerank-chunks.ts";
import { buildPrompt, PromptConstructionError } from "../../../lib/rag/build-prompt.ts";
import { AnswerGenerationError, generateAnswer } from "../../../lib/rag/generate-answer.ts";

// cacheComponents requires Node.js and rejects route-level runtime exports.
const REQUEST_TIMEOUT_MS = 180_000;

function errorResponse(error: string, code: string, status: number, details?: ChatQueryError["details"]) {
  return Response.json({ error, code, ...(details ? { details } : {}) }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const query = await readChatQuery(request);
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      return errorResponse("The AI service is not configured", "AI_NOT_CONFIGURED", 503);
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const queryVector = await embedQuery(query.question, { signal });
    const retrievedChunks = await searchVectors(queryVector, { signal });
    const selectedChunks = await rerankChunks(query.question, retrievedChunks, { signal });
    signal.throwIfAborted();
    const prompt = buildPrompt(query.question, selectedChunks);
    const answer = await generateAnswer(prompt, { signal });
    // Generation resolves cited labels against answer.sources before stream completion.
    // Only answer text and verified display metadata are serialized; prompts stay private.
    return new Response(answer.stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-RAG-Query-Status": "ready",
        "X-RAG-Search-Status": retrievedChunks.length ? "ready" : "empty",
        "X-RAG-Retrieved-Chunks": String(retrievedChunks.length),
        "X-RAG-Rerank-Status": selectedChunks.some((chunk) => chunk.rerankScore !== undefined) ? "ready" : "original",
        "X-RAG-Selected-Chunks": String(selectedChunks.length),
        "X-RAG-Prompt-Status": prompt.includedChunkCount ? "ready" : "empty",
        "X-RAG-Prompt-Sources": String(Object.keys(answer.sources).length),
        "X-RAG-Answer-Status": answer.status,
      },
    });
  } catch (error) {
    if (request.signal.aborted) return errorResponse("The request was cancelled", "REQUEST_CANCELLED", 499);
    if (error instanceof ChatQueryError) return errorResponse(error.message, error.code, error.status, error.details);
    if (error instanceof AnswerGenerationError) return errorResponse(error.message, error.code, error.status);
    if (error instanceof Error && error.name === "TimeoutError") {
      return errorResponse("The request took too long to complete. Please try again.", "AI_TIMEOUT", 504);
    }
    if (error instanceof PromptConstructionError) {
      return errorResponse(error.code === "BUDGET_EXCEEDED"
        ? "The question exceeds the configured context budget. Try a shorter question."
        : "The document context could not be prepared.", "RAG_PROMPT_ERROR", error.code === "BUDGET_EXCEEDED" ? 400 : 503);
    }
    if (error instanceof EmbeddingGenerationError || error instanceof QdrantStorageError) {
      return errorResponse("Document retrieval is temporarily unavailable. Please try again.", "RAG_UNAVAILABLE", 503);
    }
    return errorResponse("The chat request could not be processed. Please try again.", "INTERNAL_ERROR", 500);
  }
}
