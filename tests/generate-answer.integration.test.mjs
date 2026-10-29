import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt } from "../src/lib/rag/build-prompt.ts";
import { generateAnswer } from "../src/lib/rag/generate-answer.ts";
import { readChatStream } from "../app/lib/read-chat-stream.ts";
import { POST } from "../src/app/api/chat/route.ts";

test("live project LLM streams an answer grounded in synthetic evidence", {
  skip: process.env.RUN_ANSWER_INTEGRATION !== "1" || !process.env.OPENROUTER_API_KEY?.trim()
    ? "Requires RUN_ANSWER_INTEGRATION=1 and a valid OPENROUTER_API_KEY." : false,
  timeout: 190000,
}, async () => {
  const prompt = buildPrompt("What is the project codename? Cite the source.", [{
    documentId: "synthetic-document", sourceName: "synthetic-smoke.txt", chunkId: "synthetic-chunk",
    chunkIndex: 0, page: 1, pageNumber: 1, score: 1, text: "The project codename is Copper Finch.",
  }]);
  const answer = await generateAnswer(prompt, { signal: AbortSignal.timeout(180000) });
  let text = "";
  await readChatStream(answer.stream, (part) => { text += part; });
  assert.equal(answer.status, "grounded");
  assert.match(text, /Copper Finch/i);
  assert.match(text, /\[S1\]/);
  assert.equal(answer.sources["[S1]"].documentId, "synthetic-document");
});

test("live complete chat pipeline retrieves sample evidence from Qdrant and streams an answer", {
  skip: process.env.RUN_ANSWER_INTEGRATION !== "1"
    || !["OPENROUTER_API_KEY", "QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION"].every((name) => process.env[name]?.trim())
    ? "Requires RUN_ANSWER_INTEGRATION=1, server credentials, and npm run ingest." : false,
  timeout: 190000,
}, async () => {
  const response = await POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "What is the TaskFlow API rate limit? Cite the source." }),
    signal: AbortSignal.timeout(180000),
  }));
  assert.equal(response.status, 200, "The configured retrieval/generation services must be available.");
  assert.equal(response.headers.get("X-RAG-Answer-Status"), "grounded");
  assert.ok(Number(response.headers.get("X-RAG-Prompt-Sources")) > 0);
  let text = "";
  await readChatStream(response.body, (part) => { text += part; });
  assert.match(text, /60/);
  assert.match(text, /\[S\d+\]/);
});
