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

test("live universal assistant preserves Russian dialogue and refuses unsupported TaskFlow pricing", {
  skip: process.env.RUN_ANSWER_INTEGRATION !== "1" || !process.env.OPENROUTER_API_KEY?.trim()
    ? "Requires RUN_ANSWER_INTEGRATION=1 and a valid OPENROUTER_API_KEY." : false,
  timeout: 190000,
}, async (t) => {
  await t.test("Russian general follow-up without documents", async () => {
    const prompt = buildPrompt("Как меня зовут? Ответь кратко.", [], { history: [
      { id: "first:user", role: "user", content: "Меня зовут Алексей." },
      { id: "first:assistant", role: "assistant", content: "Рад знакомству!" },
    ] });
    const answer = await generateAnswer(prompt, { signal: AbortSignal.timeout(90000) });
    let text = "";
    const citations = await readChatStream(answer.stream, (part) => { text += part; });
    assert.match(text, /Алексей/iu);
    assert.deepEqual(citations, []);
  });
  await t.test("Russian answer does not guess an undocumented product price", async () => {
    const prompt = buildPrompt("Сколько стоит тариф TaskFlow Space Platinum 2099? Ответь кратко по-русски.", []);
    const answer = await generateAnswer(prompt, { signal: AbortSignal.timeout(90000) });
    let text = "";
    const citations = await readChatStream(answer.stream, (part) => { text += part; });
    assert.match(text, /нет|недостаточ|не (?:указан|содерж|могу|располагаю|предоставлен|извест)/iu);
    assert.doesNotMatch(text, /\$\s*\d|\d+\s*(?:руб|доллар|USD|RUB|евро)/iu);
    assert.deepEqual(citations, []);
  });
});

test("live Russian answer uses English document evidence and preserves its citation", {
  skip: process.env.RUN_ANSWER_INTEGRATION !== "1" || !process.env.OPENROUTER_API_KEY?.trim()
    ? "Requires RUN_ANSWER_INTEGRATION=1 and a valid OPENROUTER_API_KEY." : false,
  timeout: 95000,
}, async () => {
  const prompt = buildPrompt("Какой лимит API у TaskFlow? Ответь кратко по-русски и укажи источник.", [{
    documentId: "synthetic-document", sourceName: "api-guide.pdf", chunkId: "synthetic-api-chunk",
    chunkIndex: 0, page: 3, pageNumber: 3, score: 1, text: "TaskFlow API rate limit: 60 requests per minute.",
  }]);
  const answer = await generateAnswer(prompt, { signal: AbortSignal.timeout(90000) });
  let text = "";
  const citations = await readChatStream(answer.stream, (part) => { text += part; });
  assert.match(text, /60/);
  assert.match(text, /запрос/iu);
  assert.match(text, /\[S1\]/);
  assert.equal(citations[0]?.documentId, "synthetic-document");
  assert.equal(citations[0]?.pageNumber, 3);
});
