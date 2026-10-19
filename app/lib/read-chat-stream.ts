// Events and UTF-8 characters can both span multiple network chunks.
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onContent: (content: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processEvent(event: string) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");

    if (!data) return false;
    if (data === "[DONE]") return true;

    const chunk = JSON.parse(data);
    if (chunk.error || chunk.choices?.[0]?.finish_reason === "error") {
      throw new Error(chunk.error?.message || "Response generation failed");
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string") onContent(content);
    return false;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (processEvent(event)) return;
      }

      if (done) {
        if (buffer && processEvent(buffer)) return;
        throw new Error("The response stream ended unexpectedly. Please try again.");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
