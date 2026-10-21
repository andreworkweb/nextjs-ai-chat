import {
  buildContext,
  ChatContextError,
  MAX_COMPLETION_TOKENS,
  readChatRequest,
} from "../../lib/chat-context/context";

const GENERATION_TIMEOUT_MS = 180_000;

function chatError(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  try {
    const request = await readChatRequest(req);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return chatError("The AI service is not configured", 503);
    }

    // The same signal remains active while the response body streams.
    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    ]);
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal,
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        stream: true,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: buildContext(request),
      }),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) {
        return chatError("The AI service is busy. Please try again shortly.", 429);
      }
      if (response.status === 400 || response.status === 413) {
        return chatError("The AI service could not accept this context. Try a shorter message or start a new conversation.", 400);
      }
      return chatError("OpenRouter request failed. Please try again.", 502);
    }

    if (!response.body) {
      return chatError("OpenRouter returned no stream", 502);
    }

    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof ChatContextError) {
      return chatError(error.message, error.status);
    }
    if (req.signal.aborted) {
      return chatError("The request was cancelled", 499);
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return chatError("The AI service took too long to respond. Please try again.", 504);
    }
    return chatError("The AI service could not be reached. Please try again.", 502);
  }
}
