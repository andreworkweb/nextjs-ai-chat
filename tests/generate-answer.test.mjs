import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildPrompt } from "../src/lib/rag/build-prompt.ts";
import { AnswerGenerationError, generateAnswer, INSUFFICIENT_EVIDENCE } from "../src/lib/rag/generate-answer.ts";
import { readChatStream } from "../app/lib/read-chat-stream.ts";
import { completionEvent, completionResponse } from "./helpers/openrouter-stream.mjs";

const names = ["OPENROUTER_API_KEY", "LLM_MODEL", "LLM_TIMEOUT_MS", "RAG_CONTEXT_TOKEN_BUDGET"];
const saved = new Map(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of names) delete process.env[name];
  process.env.OPENROUTER_API_KEY = "fake-private-key";
  mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected live request"); });
});
afterEach(() => {
  mock.restoreAll();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
function prompt() {
  return buildPrompt("What is the limit?", [{
    documentId: "real-document", chunkId: "original-chunk", sourceName: "guide.pdf", chunkIndex: 1,
    page: 3, pageNumber: 3, score: 0.9, text: "The API limit is 60 requests per minute.",
  }]);
}
async function text(answer) {
  let output = "";
  await readChatStream(answer.stream, (part) => { output += part; });
  return output;
}
async function expectError(action, code, status) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof AnswerGenerationError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /fake-private-key|private-body|The API limit/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("AI SDK sends the grounded structured prompt to the existing service and streams compatible text", async () => {
  process.env.LLM_MODEL = "configured/model";
  const input = prompt();
  let calls = 0;
  const answer = await generateAnswer(input, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fake-private-key");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "configured/model");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 8192);
    assert.deepEqual(body.messages, input.messages);
    assert.equal(body.tools, undefined);
    return completionResponse("60 requests per minute. [S1]");
  } });
  assert.equal(answer.status, "grounded");
  assert.deepEqual(answer.sources, input.sources);
  assert.notEqual(answer.sources, input.sources);
  assert.equal(await text(answer), "60 requests per minute. [S1]");
  assert.equal(calls, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("default model is the existing project model and source identities survive streaming", async () => {
  const input = prompt();
  const answer = await generateAnswer(input, { fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    return completionResponse("Answer [S1]");
  } });
  input.sources["[S1]"].pageNumber = 99;
  assert.equal(answer.sources["[S1]"].pageNumber, 3);
  assert.equal(answer.sources["[S1]"].chunkId, "original-chunk");
  await text(answer);
});

test("empty useful context streams an honest abstention without an LLM request or credentials", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const answer = await generateAnswer(buildPrompt("Unrelated question?", []));
  assert.equal(answer.status, "insufficient-evidence");
  assert.deepEqual(answer.sources, {});
  assert.equal(await text(answer), INSUFFICIENT_EVIDENCE);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("invalid prompts, missing credentials, and invalid server settings fail safely", async () => {
  for (const input of [null, {}, { ...prompt(), messages: [] }, { ...prompt(), tokenBudget: 1 }, { ...prompt(), sources: {} }]) {
    await expectError(() => generateAnswer(input), "INVALID_PROMPT", 400);
  }
  delete process.env.OPENROUTER_API_KEY;
  await expectError(() => generateAnswer(prompt()), "AI_NOT_CONFIGURED", 503);
  process.env.OPENROUTER_API_KEY = "fake-private-key";
  for (const [name, value] of [["LLM_MODEL", ""], ["LLM_MODEL", "bad\nmodel"], ["LLM_TIMEOUT_MS", "0"], ["LLM_TIMEOUT_MS", "invalid"]]) {
    process.env[name] = value;
    await expectError(() => generateAnswer(prompt()), "AI_NOT_CONFIGURED", 503);
    delete process.env[name];
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("mismatched or fabricated citation metadata is rejected before contacting the model", async () => {
  const inconsistent = prompt();
  inconsistent.sources["[S1]"].documentId = "other-document";
  await expectError(() => generateAnswer(inconsistent), "INVALID_PROMPT", 400);
  const invalidJson = prompt();
  invalidJson.messages[1].content = "private-body";
  await expectError(() => generateAnswer(invalidJson), "INVALID_PROMPT", 400);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("initial HTTP failures use meaningful safe errors and do not retry generation", async () => {
  for (const [status, expected, code] of [[429, 429, "AI_RATE_LIMITED"], [400, 400, "AI_REQUEST_REJECTED"],
    [413, 400, "AI_REQUEST_REJECTED"], [401, 502, "AI_UPSTREAM_ERROR"], [503, 502, "AI_UPSTREAM_ERROR"]]) {
    let calls = 0;
    await expectError(() => generateAnswer(prompt(), { fetch: async () => {
      calls++;
      return Response.json({ error: { message: "private-body fake-private-key" } }, { status });
    } }), code, expected);
    assert.equal(calls, 1);
  }
});

test("network failures do not expose provider details or log private prompts", async () => {
  const log = mock.method(console, "error", () => {});
  await expectError(() => generateAnswer(prompt(), { fetch: async () => { throw new Error("private-body fake-private-key"); } }), "AI_UNAVAILABLE", 502);
  assert.equal(log.mock.callCount(), 0);
});

test("total generation timeout covers both initial wait and stalled response bodies", async () => {
  process.env.LLM_TIMEOUT_MS = "20";
  await expectError(() => generateAnswer(prompt(), { fetch: async (_url, init) => {
    await delay(1000, undefined, { signal: init.signal });
    return completionResponse();
  } }), "AI_TIMEOUT", 504);
});

test("streaming begins before completion and late provider failures become sanitized stream errors", async () => {
  const encoder = new TextEncoder();
  let upstream;
  const body = new ReadableStream({ start(controller) {
    upstream = controller;
    controller.enqueue(encoder.encode(completionEvent({ content: "Partial answer" })));
  } });
  const answer = await generateAnswer(prompt(), { fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }) });
  const reader = answer.stream.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /Partial answer/);
  upstream.enqueue(encoder.encode('data: {"error":{"message":"private-body fake-private-key","code":500}}\n\n'));
  upstream.close();
  const rest = new TextDecoder().decode((await reader.read()).value);
  assert.match(rest, /"error"/);
  assert.doesNotMatch(rest, /private-body|fake-private-key|\[DONE\]/);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("a stalled stream times out after headers without reporting a successful DONE", async () => {
  process.env.LLM_TIMEOUT_MS = "30";
  const answer = await generateAnswer(prompt(), { fetch: async (_url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(completionEvent({ content: "Partial" })));
    init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
  } }), { headers: { "Content-Type": "text/event-stream" } }) });
  await assert.rejects(() => text(answer), /took too long/);
});

test("empty and malformed upstream responses cannot complete successfully", async () => {
  for (const response of [completionResponse(""), new Response("not SSE", { headers: { "Content-Type": "text/event-stream" } }), new Response(null)]) {
    await assert.rejects(() => generateAnswer(prompt(), { fetch: async () => response }), AnswerGenerationError);
  }
});

test("truncated or filtered provider output cannot be marked as completed", async () => {
  for (const tail of ["data: [DONE]\n\n", completionEvent({}, "content_filter") + "data: [DONE]\n\n"]) {
    const answer = await generateAnswer(prompt(), { fetch: async () => new Response(completionEvent({ content: "Partial" }) + tail,
      { headers: { "Content-Type": "text/event-stream" } }) });
    await assert.rejects(() => text(answer), /could not complete/);
  }
});

test("client cancellation aborts the provider request and releases the stream", async () => {
  let providerSignal;
  const answer = await generateAnswer(prompt(), { fetch: async (_url, init) => {
    providerSignal = init.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(completionEvent({ content: "First" })));
      init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  await answer.stream.cancel();
  assert.equal(providerSignal.aborted, true);
});

test("already-aborted callers never start an LLM request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => generateAnswer(prompt(), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
