import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
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
      ? loadTypeScript(path.relative(path.resolve(testDir, ".."), path.resolve(path.dirname(file), id.endsWith(".ts") ? id : `${id}.ts`)))
      : nodeRequire(id);
  new Function("module", "exports", "require", compiled.outputText)(loaded, loaded.exports, localRequire);
  return loaded.exports;
}

const {
  buildContext,
  ChatContextError,
  MAX_REQUEST_BYTES,
  parseChatRequest,
  readChatRequest,
} = loadTypeScript("app/lib/chat-context/context.ts");
const { MAX_HISTORY_MESSAGES, MAX_MESSAGE_BYTES } = loadTypeScript("app/lib/chat-context/types.ts");

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
