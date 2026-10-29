import { env } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, streamText } from "ai";
import { MAX_COMPLETION_TOKENS, estimateMessageTokens } from "../../../app/lib/chat-context/context.ts";
import type { BuiltPrompt } from "./types.ts";

export const INSUFFICIENT_EVIDENCE = "The supplied documents do not provide enough information to answer this question.";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

export class AnswerGenerationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AnswerGenerationError";
    this.code = code;
    this.status = status;
  }
}

export interface GenerateAnswerOptions {
  signal?: AbortSignal;
  /** Inject the provider transport for tests; credentials stay on the server. */
  fetch?: typeof globalThis.fetch;
}

export interface GeneratedAnswer {
  stream: ReadableStream<Uint8Array>;
  /** Server-side citation identity, retained for the next citation presentation step. */
  sources: BuiltPrompt["sources"];
  status: "grounded" | "insufficient-evidence";
}

function safeError(error: unknown, signal: AbortSignal): AnswerGenerationError {
  if (signal.aborted) {
    return signal.reason?.name === "TimeoutError"
      ? new AnswerGenerationError("AI_TIMEOUT", "The AI service took too long to respond. Please try again.", 504)
      : new AnswerGenerationError("REQUEST_CANCELLED", "The request was cancelled", 499);
  }
  if (error instanceof AnswerGenerationError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new AnswerGenerationError("AI_TIMEOUT", "The AI service took too long to respond. Please try again.", 504);
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return new AnswerGenerationError("AI_RATE_LIMITED", "The AI service is busy. Please try again shortly.", 429);
    if (error.statusCode === 400 || error.statusCode === 413) {
      return new AnswerGenerationError("AI_REQUEST_REJECTED", "The AI service could not accept this context. Try a shorter question.", 400);
    }
    return new AnswerGenerationError("AI_UPSTREAM_ERROR", "The AI service could not complete the response. Please try again.", 502);
  }
  return new AnswerGenerationError("AI_UNAVAILABLE", "The AI service could not be reached. Please try again.", 502);
}

const encoder = new TextEncoder();
function event(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}
function textEvent(text: string): Uint8Array {
  return event({ choices: [{ delta: { content: text } }] });
}

/** Accept only the bounded structured prompt produced by buildPrompt. */
function validatePrompt(prompt: BuiltPrompt): void {
  if (!prompt || !Array.isArray(prompt.messages) || prompt.messages.length !== 2
    || prompt.messages[0]?.role !== "system" || prompt.messages[1]?.role !== "user"
    || prompt.messages.some((message) => typeof message.content !== "string" || !message.content.trim())
    || !prompt.sources || typeof prompt.sources !== "object" || Array.isArray(prompt.sources)
    || !Number.isSafeInteger(prompt.includedChunkCount) || prompt.includedChunkCount < 0
    || Object.keys(prompt.sources).length !== prompt.includedChunkCount
    || !Number.isSafeInteger(prompt.tokenBudget) || prompt.tokenBudget < 1 || prompt.tokenBudget > 131072
    || prompt.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) > prompt.tokenBudget) {
    throw new AnswerGenerationError("INVALID_PROMPT", "A valid bounded evidence prompt is required.", 400);
  }
  try {
    const data = JSON.parse(prompt.messages[1].content);
    if (typeof data.question !== "string" || !data.question.trim()
      || !Array.isArray(data.documentContext?.sources)
      || data.documentContext.sources.length !== prompt.includedChunkCount
      || data.documentContext.sources.some((source: Record<string, unknown>, index: number) => {
        const label = `[S${index + 1}]` as keyof BuiltPrompt["sources"];
        const mapping = prompt.sources[label];
        return !source || source.citation !== label || typeof source.text !== "string" || !source.text.trim()
          || !mapping || !Number.isSafeInteger(mapping.pageNumber) || mapping.pageNumber < 1
          || mapping.page !== mapping.pageNumber || !Number.isSafeInteger(mapping.chunkIndex) || mapping.chunkIndex < 0
          || ["documentId", "sourceName", "chunkId"].some((key) => {
            const value = mapping[key as keyof typeof mapping];
            return typeof value !== "string" || !value.trim();
          })
          || Object.entries(mapping).some(([key, value]) => source[key] !== value);
      })) throw new Error();
  } catch {
    throw new AnswerGenerationError("INVALID_PROMPT", "The prompt evidence and citation mapping must match.", 400);
  }
}

/** Stream grounded text using the existing OpenRouter service through AI SDK 7. */
export async function generateAnswer(prompt: BuiltPrompt, options: GenerateAnswerOptions = {}): Promise<GeneratedAnswer> {
  if (typeof window !== "undefined") {
    throw new AnswerGenerationError("AI_NOT_CONFIGURED", "Answer generation is only available on the Node.js server.", 503);
  }
  validatePrompt(prompt);
  options.signal?.throwIfAborted();
  const sources = structuredClone(prompt.sources);
  const messages = prompt.messages.map((message) => ({ ...message }));
  if (prompt.includedChunkCount === 0) {
    return {
      status: "insufficient-evidence", sources,
      stream: new ReadableStream({ start(controller) {
        controller.enqueue(textEvent(INSUFFICIENT_EVIDENCE));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } }),
    };
  }

  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model = env.LLM_MODEL === undefined ? DEFAULT_MODEL : env.LLM_MODEL.trim();
  const timeoutMs = env.LLM_TIMEOUT_MS === undefined ? 180000
    : /^\d+$/u.test(env.LLM_TIMEOUT_MS) ? Number(env.LLM_TIMEOUT_MS) : NaN;
  if (!apiKey || !/^[\x21-\x7e]+$/u.test(apiKey) || !model || model.length > 256 || /[\s\u0000-\u001f]/u.test(model)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new AnswerGenerationError("AI_NOT_CONFIGURED", "Configure a valid OPENROUTER_API_KEY, LLM_MODEL, and LLM_TIMEOUT_MS on the server.", 503);
  }

  const localAbort = new AbortController();
  const signal = AbortSignal.any([localAbort.signal, ...(options.signal ? [options.signal] : [])]);
  const timer = setTimeout(() => localAbort.abort(new DOMException("Generation deadline exceeded", "TimeoutError")), timeoutMs);
  const transport = options.fetch ?? globalThis.fetch;
  const provider = createOpenAI({
    apiKey, baseURL: "https://openrouter.ai/api/v1", name: "openrouter",
    fetch: async (url, init) => {
      // No redirects with credentials; prevent request caching or provider errors
      // from carrying private prompts into application logs/responses.
      const response = await transport(url, { ...init, cache: "no-store", redirect: "error" });
      return response;
    },
  });

  async function* textParts() {
    try {
      const result = streamText({
        model: provider.chat(model),
        instructions: messages[0].content,
        messages: [messages[1]],
        maxOutputTokens: MAX_COMPLETION_TOKENS,
        maxRetries: 0,
        abortSignal: signal,
        onError: () => {},
        onEnd: () => { clearTimeout(timer); },
        onAbort: () => { clearTimeout(timer); },
      });
      let finished = false;
      for await (const part of result.stream) {
        signal.throwIfAborted();
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throw new AnswerGenerationError("REQUEST_CANCELLED", "The request was cancelled", 499);
        if (part.type === "text-delta" && part.text) yield part.text;
        if (part.type === "finish") {
          if (part.finishReason !== "stop" && part.finishReason !== "length") {
            throw new AnswerGenerationError("AI_UPSTREAM_ERROR", "The AI service could not complete the response. Please try again.", 502);
          }
          finished = true;
        }
      }
      signal.throwIfAborted();
      if (!finished) throw new AnswerGenerationError("AI_UPSTREAM_ERROR", "The AI response ended unexpectedly. Please try again.", 502);
    } catch (error) {
      throw safeError(error, signal);
    } finally {
      clearTimeout(timer);
    }
  }

  const iterator = textParts();
  // Wait for the first actual text so early authentication/rate-limit errors can
  // still use meaningful HTTP status codes before response headers are sent.
  const first = await iterator.next();
  if (first.done) throw new AnswerGenerationError("AI_EMPTY_RESPONSE", "The AI service returned no answer text.", 502);
  return {
    status: "grounded", sources,
    stream: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(textEvent(first.value)); },
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } else controller.enqueue(textEvent(next.value));
        } catch (error) {
          const safe = safeError(error, signal);
          controller.enqueue(event({ error: { message: safe.message, code: safe.code } }));
          controller.close();
        }
      },
      async cancel() {
        localAbort.abort();
        clearTimeout(timer);
        await iterator.return(undefined).catch(() => {});
      },
    }),
  };
}
