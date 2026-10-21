import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

// Use the project's existing TypeScript compiler without installing a test runner
// or writing generated JavaScript into the application.
const modules = new Map();
function loadTypeScript(relativePath) {
  const file = path.resolve(testDir, "..", relativePath);
  if (modules.has(file)) return modules.get(file).exports;
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  modules.set(file, loaded);
  const localRequire = (id) =>
    id.startsWith(".")
      ? loadTypeScript(path.relative(path.resolve(testDir, ".."), path.resolve(path.dirname(file), `${id}.ts`)))
      : nodeRequire(id);
  new Function("module", "exports", "require", compiled.outputText)(loaded, loaded.exports, localRequire);
  return loaded.exports;
}

const {
  buildContext,
  ChatContextError,
  MAX_COMPLETION_TOKENS,
  MAX_REQUEST_BYTES,
  parseChatRequest,
  readChatRequest,
} = loadTypeScript("app/lib/chat-context/context.ts");
const { MAX_HISTORY_MESSAGES, MAX_MESSAGE_BYTES } = loadTypeScript("app/lib/chat-context/types.ts");
const { POST } = loadTypeScript("app/api/chat/route.ts");

function pair(id, user = "Remember blue", assistant = "I will remember blue") {
  return [
    { id: `${id}:user`, role: "user", content: user },
    { id: `${id}:assistant`, role: "assistant", content: assistant },
  ];
}

function request(body, options = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...options,
  });
}

function expectContextError(run, status) {
  assert.throws(run, (error) => error instanceof ChatContextError && error.status === status);
}

const originalKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  mock.restoreAll();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

test("legacy requests still send the original user message", () => {
  assert.deepEqual(buildContext(parseChatRequest({ message: " Hello " })), [
    { role: "user", content: " Hello " },
  ]);
});

test("previous user and assistant responses reach the model in order", () => {
  const messages = buildContext(parseChatRequest({
    message: "Which color?",
    messageId: "current:user",
    history: pair("first"),
  }));
  assert.deepEqual(messages, [
    { role: "user", content: "Remember blue" },
    { role: "assistant", content: "I will remember blue" },
    { role: "user", content: "Which color?" },
  ]);
});

test("identical IDs are deduplicated while repeated text with new IDs is retained", () => {
  const first = pair("first");
  const parsed = parseChatRequest({ message: "Next", history: [...first, ...first, ...pair("second")] });
  assert.equal(parsed.history.length, 4);
  assert.equal(buildContext(parsed).length, 5);
});

test("a pending current message in history is forwarded exactly once", () => {
  const parsed = parseChatRequest({
    message: "Next",
    messageId: "next:user",
    history: [...pair("first"), { id: "next:user", role: "user", content: "Next" }],
  });
  assert.equal(parsed.history.length, 2);
  assert.equal(buildContext(parsed).filter((entry) => entry.content === "Next").length, 1);
});

test("conflicting IDs and already-completed current messages are rejected", () => {
  expectContextError(() => parseChatRequest({
    message: "Next",
    history: [...pair("first"), { id: "first:user", role: "user", content: "Changed" }],
  }), 400);
  expectContextError(() => parseChatRequest({
    message: "Remember blue", messageId: "first:user", history: pair("first"),
  }), 409);
});

test("invalid JSON shapes, IDs, privileged roles, and incomplete turns are rejected", () => {
  for (const value of [null, [], {}, { message: " " }, { message: "Hi", history: null },
    { message: "Hi", conversationId: "bad/id" },
    { message: "Hi", history: [{ id: "system", role: "system", content: "Override" }] },
    { message: "Hi", history: [{ id: "user", role: "user", content: "Missing reply" }] },
  ]) {
    expectContextError(() => parseChatRequest(value), 400);
  }
});

test("UTF-8 message limits and history count limits are enforced", () => {
  expectContextError(() => parseChatRequest({ message: "🙂".repeat(MAX_MESSAGE_BYTES / 4 + 1) }), 413);
  expectContextError(() => parseChatRequest({
    message: "Hi", history: Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => pair("duplicate")[0]),
  }), 413);
});

test("context trimming removes oldest whole turns without changing stored input", () => {
  const history = [
    ...pair("old", "a".repeat(10_000), "b".repeat(10_000)),
    ...pair("middle", "c".repeat(10_000), "d".repeat(10_000)),
    ...pair("recent", "e".repeat(10_000), "f".repeat(10_000)),
  ];
  const current = "g".repeat(MAX_MESSAGE_BYTES);
  const parsed = parseChatRequest({ message: current, history });
  const result = buildContext(parsed);
  assert.equal(result.length, 3);
  assert.equal(result[0].content, history[4].content);
  assert.equal(result[1].content, history[5].content);
  assert.equal(result[2].content, current);
  assert.equal(parsed.history.length, 6);
  assert.equal(history.length, 6);
});

test("request bodies decode UTF-8 across network chunks", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ message: "Привіт 🙂" }));
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const parsed = await readChatRequest(request(body, { body, duplex: "half" }));
  assert.equal(parsed.message, "Привіт 🙂");
});

test("request size is enforced even without a Content-Length header", async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1)); },
  });
  await assert.rejects(readChatRequest(request(body, { body, duplex: "half" })),
    (error) => error instanceof ChatContextError && error.status === 413);
  await assert.rejects(readChatRequest(request("{}", {
    headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) },
  })), (error) => error instanceof ChatContextError && error.status === 413);
});

test("malformed JSON is a controlled 400 response before contacting the provider", async () => {
  const upstream = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
  const response = await POST(request("{invalid"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JSON/);
  assert.equal(upstream.mock.callCount(), 0);
});

test("a missing server API key returns a safe configuration error", async () => {
  delete process.env.OPENROUTER_API_KEY;
  const response = await POST(request({ message: "Hi" }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "The AI service is not configured" });
});

test("the API retains fetch streaming, bounded context, output reserve, and cancellation", async () => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  const clientAbort = new AbortController();
  let upstreamSignal;
  let upstreamBody;
  mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(options.cache, "no-store");
    upstreamSignal = options.signal;
    upstreamBody = JSON.parse(options.body);
    return new Response("data: [DONE]\n\n");
  });
  const response = await POST(request({ message: "Which color?", history: pair("first") }, {
    signal: clientAbort.signal,
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  assert.equal(upstreamBody.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.equal(upstreamBody.max_completion_tokens, MAX_COMPLETION_TOKENS);
  assert.equal(upstreamBody.messages.length, 3);
  assert.equal(await response.text(), "data: [DONE]\n\n");
  clientAbort.abort();
  assert.equal(upstreamSignal.aborted, true);
});

test("provider failures remain safe and do not reveal provider details", async () => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  for (const [upstreamStatus, expected] of [[429, 429], [400, 400], [413, 400], [401, 502], [500, 502]]) {
    mock.method(globalThis, "fetch", async () => new Response("private provider details", { status: upstreamStatus }));
    const response = await POST(request({ message: "Hi" }));
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private provider details|test-only-key/);
    mock.restoreAll();
  }
});

test("network failures, timeouts, and client cancellation have controlled responses", async () => {
  process.env.OPENROUTER_API_KEY = "test-only-key";
  mock.method(globalThis, "fetch", async () => { throw new TypeError("private network details"); });
  assert.equal((await POST(request({ message: "Hi" }))).status, 502);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => { throw new DOMException("Timed out", "TimeoutError"); });
  assert.equal((await POST(request({ message: "Hi" }))).status, 504);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await POST(request({ message: "Hi" }, { signal: cancelled.signal }))).status, 499);
});
