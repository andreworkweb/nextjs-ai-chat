// Real OpenRouter/OpenAI Chat Completions wire format, parsed by the actual SDK.
export function completionEvent(delta, finish_reason = null) {
  return `data: ${JSON.stringify({ id: "test-completion", object: "chat.completion.chunk", created: 1,
    model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}

export function completionResponse(text = "Hello") {
  return new Response(completionEvent({ content: text }) + completionEvent({}, "stop") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
