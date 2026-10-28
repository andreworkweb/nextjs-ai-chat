import { ChatQueryError, readChatQuery } from "../../../lib/rag/chat-request.ts";
import { buildContext, MAX_COMPLETION_TOKENS } from "../../../../app/lib/chat-context/context.ts";

// next.config.ts enables cacheComponents, which requires the Node.js runtime.
// This Next.js version rejects route-level runtime exports with that setting.
const GENERATION_TIMEOUT_MS = 180_000;

function errorResponse(error: string, code: string, status: number, details?: ChatQueryError["details"]) {
  return Response.json(
    { error, code, ...(details ? { details } : {}) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let generating = false;
  try {
    const query = await readChatQuery(request);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return errorResponse("The AI service is not configured", "AI_NOT_CONFIGURED", 503);
    }

    const messages = buildContext({ ...query, message: query.question });
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    ]);
    generating = true;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal,
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        stream: true,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages,
      }),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        return errorResponse("The AI service is busy. Please try again shortly.", "AI_RATE_LIMITED", 429);
      }
      if (response.status === 400 || response.status === 413) {
        return errorResponse(
          "The AI service could not accept this context. Try a shorter message or start a new conversation.",
          "AI_REQUEST_REJECTED",
          400,
        );
      }
      return errorResponse("OpenRouter request failed. Please try again.", "AI_UPSTREAM_ERROR", 502);
    }
    if (!response.body) {
      return errorResponse("OpenRouter returned no stream", "AI_EMPTY_RESPONSE", 502);
    }
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      return errorResponse("The request was cancelled", "REQUEST_CANCELLED", 499);
    }
    if (error instanceof ChatQueryError) {
      return errorResponse(error.message, error.code, error.status, error.details);
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return errorResponse("The AI service took too long to respond. Please try again.", "AI_TIMEOUT", 504);
    }
    if (generating) {
      return errorResponse("The AI service could not be reached. Please try again.", "AI_UNAVAILABLE", 502);
    }
    return errorResponse(
      "The chat request could not be processed. Please try again.",
      "INTERNAL_ERROR",
      500,
    );
  }
}
