import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { QdrantClient } from "@qdrant/js-client-rest";
import { completionResponse } from "./helpers/openrouter-stream.mjs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const encoder = new TextEncoder();
const ownerId = "test-browser";
const historyKey = `chat-context:conversation:v1:${ownerId}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function completeTurn(id, user = "Remember blue", answer = "I remember blue") {
  return {
    id,
    user: { id: `${id}:user`, role: "user", content: user },
    assistant: { id: `${id}:assistant`, role: "assistant", content: answer },
    status: "complete",
  };
}

function savedConversation(turns = []) {
  return { version: 1, id: "original-chat", ownerId, turns };
}

function streamResponse() {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    content(text) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
    },
    citations(citations) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`));
    },
    done() { controller.enqueue(encoder.encode("data: [DONE]\n\n")); },
    interrupt() { controller.close(); },
  };
}

function finishedResponse(text = "Answer") {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
}

// Exercise the real hook, persistence code and stream parser. This lightweight
// scheduler supplies only React's state/effect primitives; it does not replace
// conversation behavior or require a DOM/test-renderer dependency.
function mountChat({ saved, storageUnavailable = false, locks, storageEntries } = {}) {
  const values = new Map(storageEntries ?? [["chat-context:owner:v1", ownerId]]);
  if (saved !== undefined) values.set(historyKey, typeof saved === "string" ? saved : JSON.stringify(saved));
  const writes = [];
  const listeners = new Set();
  const browser = {
    failRead: storageUnavailable,
    failWrite: storageUnavailable,
    localStorage: {
      getItem(key) {
        if (browser.failRead) throw new Error("Storage read unavailable");
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        if (browser.failWrite) throw new Error("Storage write unavailable");
        writes.push({ key, value });
        values.set(key, value);
      },
    },
    addEventListener(name, callback) { if (name === "storage") listeners.add(callback); },
    removeEventListener(name, callback) { if (name === "storage") listeners.delete(callback); },
  };
  let mounted = true;
  let scheduled = false;
  let cursor = 0;
  let current;
  let fetcher = async () => finishedResponse();
  const fetchCalls = [];
  const slots = [];
  const effects = [];
  const sameDeps = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  function schedule() {
    if (!mounted || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (mounted) ChatHarnessComponent();
    });
  }
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (value) => {
          slot.value = typeof value === "function" ? value(slot.value) : value;
          schedule();
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useCallback(callback, dependencies) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.dependencies, dependencies)) {
        slots[index] = { callback, dependencies };
      }
      return slots[index].callback;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!sameDeps(slots[index]?.dependencies, dependencies)) {
        const previousCleanup = slots[index]?.cleanup;
        const slot = { dependencies };
        slots[index] = slot;
        effects.push(() => {
          previousCleanup?.();
          slot.cleanup = callback();
        });
      }
    },
  };
  const context = vm.createContext({
    window: browser,
    navigator: { locks },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    queueMicrotask,
    fetch: (...args) => {
      fetchCalls.push(args);
      return fetcher(...args);
    },
  });
  const modules = new Map();
  function load(relative) {
    const file = path.resolve(project, relative);
    if (modules.has(file)) return modules.get(file).exports;
    const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const loaded = { exports: {} };
    modules.set(file, loaded);
    const localRequire = (id) => {
      if (id === "react") return react;
      if (!id.startsWith(".")) throw new Error(`Unexpected dependency: ${id}`);
      return load(path.relative(project, path.resolve(path.dirname(file), id.endsWith(".ts") ? id : `${id}.ts`)));
    };
    vm.runInContext(`(function(module, exports, require) { ${compiled.outputText}\n})`, context)(
      loaded, loaded.exports, localRequire,
    );
    return loaded.exports;
  }
  const { useChat } = load("app/lib/chat-context/use-chat.ts");
  function ChatHarnessComponent() {
    cursor = 0;
    current = useChat();
    for (const effect of effects.splice(0)) effect();
  }
  ChatHarnessComponent();
  return {
    get state() { return current; },
    get saved() { return JSON.parse(values.get(historyKey)); },
    get rawSaved() { return values.get(historyKey); },
    browser,
    fetchCalls,
    writes,
    setFetch(next) { fetcher = next; },
    async type(text) { current.setMessage(text); await flush(); },
    replaceSaved(next) { values.set(historyKey, JSON.stringify(next)); },
    snapshotStorage() { return [...values]; },
    storageEvent(next) {
      values.set(historyKey, JSON.stringify(next));
      for (const listener of listeners) listener({ key: historyKey });
    },
    unmount() {
      mounted = false;
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

test("reload restores completed history before sending without overwriting it", async () => {
  const saved = savedConversation([completeTurn("first")]);
  const app = mountChat({ saved });
  assert.equal(app.state.ready, false);
  await app.state.askAI();
  assert.equal(app.fetchCalls.length, 0);
  await flush();
  assert.equal(app.state.ready, true);
  assert.equal(app.state.reply, "I remember blue");
  assert.deepEqual(plain(app.state.conversation), saved);
  assert.equal(app.writes.length, 0);
  app.unmount();
});

test("prior messages and responses are sent once and a streamed answer commits only after DONE", async () => {
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Which color?");
  const send = app.state.askAI();
  await flush();
  const payload = JSON.parse(app.fetchCalls[0][1].body);
  assert.equal(payload.message, "Which color?");
  assert.equal(payload.question, "Which color?");
  assert.deepEqual(payload.history, [completeTurn("first").user, completeTurn("first").assistant]);
  assert.equal(app.saved.turns.length, 2);
  assert.equal(app.saved.turns[1].status, "pending");
  stream.content("Blue");
  await flush();
  assert.equal(app.state.reply, "Blue");
  assert.equal(app.saved.turns[1].assistant, undefined);
  stream.done();
  await send;
  await flush();
  assert.equal(app.saved.turns[1].status, "complete");
  assert.equal(app.saved.turns[1].assistant.content, "Blue");
  assert.equal(app.state.loading, false);
  app.unmount();
});

test("the chat API streams grounded evidence and preserves stored conversation history", async (t) => {
  const { POST } = await import("../app/api/chat/route.ts");
  const originalKey = process.env.OPENROUTER_API_KEY;
  const names = ["QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION", "LLM_MODEL", "LLM_TIMEOUT_MS", "RAG_CONTEXT_TOKEN_BUDGET", "RAG_RERANK_ENABLED"];
  const originalQdrant = new Map(names.map((name) => [name, process.env[name]]));
  process.env.QDRANT_URL = "https://unit.eu-central.aws.cloud.qdrant.io:6333";
  process.env.QDRANT_API_KEY = "fake-qdrant-test-key";
  process.env.QDRANT_COLLECTION = "unit_documents";
  for (const name of ["LLM_MODEL", "LLM_TIMEOUT_MS", "RAG_CONTEXT_TOKEN_BUDGET"]) delete process.env[name];
  process.env.RAG_RERANK_ENABLED = "false";
  const database = mock.method(QdrantClient.prototype, "query", async () => ({ points: [{ id: "point", score: 0.9, payload: {
    id: "chunk", documentId: "document", sourceName: "colors.txt", pageNumber: 1, chunkIndex: 0, text: "The project color is Blue.",
  } }] }));
  process.env.OPENROUTER_API_KEY = "test-only-key";
  const upstream = mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://openrouter.ai/api/v1/embeddings") {
      assert.deepEqual(JSON.parse(options.body).input, ["Which color?"]);
      return Response.json({ data: [{ index: 0, embedding: Array(1024).fill(0.25) }] });
    }
    const messages = JSON.parse(options.body).messages;
    assert.equal(messages[0].role, "system");
    assert.equal(JSON.parse(messages[1].content).question, "Which color?");
    assert.equal(JSON.parse(messages[1].content).documentContext.sources[0].text, "The project color is Blue.");
    return completionResponse("Blue");
  });
  t.after(() => {
    upstream.mock.restore();
    database.mock.restore();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    for (const [name, value] of originalQdrant) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  app.setFetch((url, init) => POST(new Request(`http://localhost${url}`, init)));
  await app.type("Which color?");
  await app.state.askAI();
  await flush();
  assert.equal(app.state.error, "");
  assert.equal(app.state.loading, false);
  assert.equal(app.state.reply, "Blue");
  assert.equal(app.saved.turns[0].status, "complete");
  assert.equal(app.saved.turns[1].status, "complete");
  assert.equal(app.saved.turns[1].assistant.content, "Blue");
  assert.equal(upstream.mock.callCount(), 2);
  assert.equal(database.mock.callCount(), 1);
  app.unmount();
});

test("citations stay with their answer through streaming, reload, and the next request", async () => {
  const first = completeTurn("first", "API?", "First [S1].");
  const firstCitation = { label: "[S1]", documentId: "first-doc", chunkId: "first-chunk", sourceName: "API.pdf", pageNumber: 3 };
  first.assistant.citations = [firstCitation];
  const app = mountChat({ saved: savedConversation([first]) });
  await flush();
  const response = streamResponse();
  app.setFetch(async () => response.response);
  await app.type("Billing?");
  const sending = app.state.askAI();
  await flush();
  const body = JSON.parse(app.fetchCalls[0][1].body);
  assert.equal(body.history[1].citations, undefined);
  const secondCitation = { label: "[S1]", documentId: "billing-doc", chunkId: "billing-chunk", sourceName: "Billing.pdf", pageNumber: 2 };
  response.content("Second [S");
  await flush();
  assert.equal(app.state.reply, "Second [S");
  assert.equal(app.saved.turns[1].assistant, undefined);
  response.content("1]. Invalid [S99].");
  response.citations([secondCitation, { ...secondCitation, label: "[S2]", sourceName: "Uncited.pdf" }]);
  await flush();
  assert.equal(app.saved.turns[1].status, "pending");
  response.done();
  await sending;
  await flush();
  assert.deepEqual(app.saved.turns[0].assistant.citations, [firstCitation]);
  assert.deepEqual(app.saved.turns[1].assistant.citations, [secondCitation]);
  const restored = mountChat({ storageEntries: app.snapshotStorage() });
  await flush();
  assert.deepEqual(plain(restored.state.conversation), app.saved);
  app.unmount();
  restored.unmount();
});

test("citation metadata from an interrupted response never enters saved history or a retry", async () => {
  const app = mountChat();
  await flush();
  const response = streamResponse();
  app.setFetch(async () => response.response);
  await app.type("Question");
  const sending = app.state.askAI();
  await flush();
  response.content("Partial [S1]");
  response.citations([{ label: "[S1]", documentId: "doc", chunkId: "chunk", sourceName: "Guide.pdf", pageNumber: 1 }]);
  response.interrupt();
  await sending;
  await flush();
  assert.equal(app.saved.turns[0].status, "failed");
  assert.equal(app.saved.turns[0].assistant, undefined);
  app.setFetch(async () => finishedResponse("Retry without citations"));
  await app.state.askAI();
  await flush();
  assert.equal(app.saved.turns[0].assistant.citations, undefined);
  app.unmount();
});

const accessibleDocumentId = "6e88c38545db0c9edf1a023928a50c36edb5e583aeec4690155da6986b7f106d";
function pdfTurn(id = "pdf") {
  const turn = completeTurn(id, "API limit?", "Answer [S1].");
  turn.assistant.citations = [{ label: "[S1]", documentId: accessibleDocumentId, chunkId: "actual-chunk", sourceName: "03_API_Guide.pdf", pageNumber: 3 }];
  return turn;
}

test("PDF availability checks reuse document IDs and do not run again on each render", async () => {
  const app = mountChat({ saved: savedConversation([pdfTurn("first"), pdfTurn("second")]) });
  app.setFetch(async (url, init) => {
    assert.equal(url, `/api/documents/${accessibleDocumentId}`);
    assert.equal(init.method, "HEAD");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    const { HEAD } = await import("../app/api/documents/[documentId]/route.ts");
    return HEAD(new Request(`http://localhost${url}`, { method: "HEAD" }), { params: Promise.resolve({ documentId: accessibleDocumentId }) });
  });
  await flush();
  // The filesystem check finishes asynchronously; wait for that specific check.
  for (let attempt = 0; attempt < 100 && !app.state.documentAvailability[accessibleDocumentId]; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(app.state.documentAvailability[accessibleDocumentId], true);
  assert.equal(app.fetchCalls.length, 1);
  await app.type("Next question");
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.saved.turns.length, 2);
  app.unmount();
});

test("unavailable, forbidden, incorrect-type, and failed availability responses leave links disabled", async () => {
  for (const result of [
    () => new Response(null, { status: 404 }), () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 500 }), () => new Response(null, { headers: { "Content-Type": "text/html" } }),
    () => { throw new TypeError("network unavailable"); },
  ]) {
    const app = mountChat({ saved: savedConversation([pdfTurn()]) });
    app.setFetch(async () => result());
    await flush();
    await flush();
    assert.equal(app.state.documentAvailability[accessibleDocumentId], false);
    assert.equal(app.state.error, "");
    assert.equal(app.saved.turns[0].assistant.content, "Answer [S1].");
    app.unmount();
  }
});

test("document availability never blocks streamed text, successful completion, or source persistence", async () => {
  const app = mountChat();
  await flush();
  const response = streamResponse();
  let finishHead;
  app.setFetch(async (_url, init) => init.method === "HEAD"
    ? new Promise((resolve) => { finishHead = resolve; }) : response.response);
  await app.type("API limit?");
  const sending = app.state.askAI();
  await flush();
  response.content("Answer [S1].");
  await flush();
  assert.equal(app.state.reply, "Answer [S1].");
  assert.equal(app.fetchCalls.length, 1);
  response.citations(pdfTurn().assistant.citations);
  response.done();
  await sending;
  await flush();
  assert.equal(app.saved.turns[0].status, "complete");
  assert.deepEqual(app.saved.turns[0].assistant.citations, pdfTurn().assistant.citations);
  assert.equal(app.state.loading, false);
  assert.equal(app.state.documentAvailability[accessibleDocumentId], undefined);
  assert.equal(app.fetchCalls.filter(([, init]) => init.method === "POST").length, 1);
  finishHead(new Response(null, { headers: { "Content-Type": "application/pdf" } }));
  await flush();
  assert.equal(app.state.documentAvailability[accessibleDocumentId], true);
  app.unmount();
});

test("clearing a conversation aborts pending document checks and ignores late availability", async () => {
  const app = mountChat({ saved: savedConversation([pdfTurn()]) });
  let completeHead;
  let checkSignal;
  app.setFetch(async (_url, init) => {
    checkSignal = init.signal;
    return new Promise((resolve) => { completeHead = resolve; });
  });
  await flush();
  app.state.clearConversation();
  await flush();
  assert.equal(checkSignal.aborted, true);
  completeHead(new Response(null, { headers: { "Content-Type": "application/pdf" } }));
  await flush();
  assert.equal(app.state.documentAvailability[accessibleDocumentId], undefined);
  assert.deepEqual(app.saved.turns, []);
  app.unmount();
});

test("same-tick submissions cannot create duplicate requests or turns", async () => {
  const app = mountChat();
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Hello");
  const send = app.state.askAI;
  const first = send();
  const second = send();
  await flush();
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.saved.turns.length, 1);
  stream.content("Hi");
  stream.done();
  await Promise.all([first, second]);
  app.unmount();
});

test("interrupted streams are excluded from history and retry reuses the user message ID", async () => {
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Retry me");
  const failed = app.state.askAI();
  await flush();
  stream.content("Partial response");
  stream.interrupt();
  await failed;
  await flush();
  const failedId = app.saved.turns[1].user.id;
  assert.equal(app.saved.turns[1].status, "failed");
  assert.equal(app.saved.turns[1].assistant, undefined);
  assert.match(app.state.error, /stream ended unexpectedly/);
  assert.equal(app.state.message, "Retry me");
  app.setFetch(async () => finishedResponse("Success"));
  await app.state.askAI();
  await flush();
  const retry = JSON.parse(app.fetchCalls[1][1].body);
  assert.equal(retry.messageId, failedId);
  assert.equal(retry.history.length, 2);
  assert.equal(app.saved.turns.length, 2);
  assert.equal(app.saved.turns[1].status, "complete");
  app.unmount();
});

test("intentional repeated prompts receive distinct IDs after completed turns", async () => {
  const app = mountChat();
  await flush();
  await app.type("Hello");
  await app.state.askAI();
  await flush();
  await app.type("Hello");
  await app.state.askAI();
  await flush();
  assert.equal(app.saved.turns.length, 2);
  assert.notEqual(app.saved.turns[0].user.id, app.saved.turns[1].user.id);
  assert.equal(JSON.parse(app.fetchCalls[1][1].body).history.length, 2);
  app.unmount();
});

test("clear aborts the active request and ignores late chunks and completion", async () => {
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Old question");
  const send = app.state.askAI();
  await flush();
  app.state.clearConversation();
  const nextId = app.saved.id;
  assert.notEqual(nextId, "original-chat");
  assert.equal(app.fetchCalls[0][1].signal.aborted, true);
  stream.content("Late answer");
  stream.done();
  await send;
  await flush();
  assert.equal(app.state.reply, "");
  assert.equal(app.state.error, "");
  assert.deepEqual(app.saved.turns, []);
  app.setFetch(async () => finishedResponse());
  await app.type("New question");
  await app.state.askAI();
  const payload = JSON.parse(app.fetchCalls[1][1].body);
  assert.equal(payload.conversationId, nextId);
  assert.deepEqual(payload.history, []);
  app.unmount();
});

test("clear in another tab also aborts and invalidates this tab's late answer", async () => {
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Old question");
  const send = app.state.askAI();
  await flush();
  app.storageEvent({ ...savedConversation(), id: "new-from-another-tab" });
  stream.content("Late answer");
  stream.done();
  await send;
  await flush();
  assert.equal(app.fetchCalls[0][1].signal.aborted, true);
  assert.equal(app.saved.id, "new-from-another-tab");
  assert.deepEqual(app.saved.turns, []);
  assert.equal(app.state.reply, "");
  app.unmount();
});

test("a failed request cannot resurrect history after an external clear with a delayed storage event", async () => {
  const app = mountChat({ saved: savedConversation([completeTurn("first")]) });
  await flush();
  let rejectFetch;
  app.setFetch(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
  await app.type("Old question");
  const send = app.state.askAI();
  await flush();

  // Browser storage is already updated, but this tab's storage event has not run.
  app.replaceSaved({ ...savedConversation(), id: "cleared-before-event" });
  rejectFetch(new TypeError("Network disconnected"));
  await send;
  await flush();
  assert.equal(app.saved.id, "cleared-before-event");
  assert.deepEqual(app.saved.turns, []);
  assert.equal(app.state.conversation.id, "cleared-before-event");
  assert.equal(app.state.reply, "");
  assert.equal(app.state.loading, false);
  app.unmount();
});

test("a pending turn recovered on reload is interrupted and retains its ID on retry", async () => {
  const pending = { id: "unfinished", user: { id: "unfinished:user", role: "user", content: "Finish me" }, status: "pending" };
  const app = mountChat({ saved: savedConversation([completeTurn("first"), pending]) });
  await flush();
  assert.equal(app.state.conversation.turns[1].status, "interrupted");
  assert.equal(app.saved.turns[1].status, "pending");
  assert.equal(app.state.reply, "I remember blue");
  await app.type("Finish me");
  await app.state.askAI();
  const payload = JSON.parse(app.fetchCalls[0][1].body);
  assert.equal(payload.messageId, "unfinished:user");
  assert.equal(payload.history.length, 2);
  assert.equal(app.saved.turns.length, 2);
  app.unmount();
});

test("sending different text after reloading a pending turn preserves it as interrupted", async () => {
  const pending = {
    id: "unfinished",
    user: { id: "unfinished:user", role: "user", content: "Old unfinished question" },
    status: "pending",
  };
  const app = mountChat({ saved: savedConversation([completeTurn("first"), pending]) });
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("A different question");
  const send = app.state.askAI();
  await flush();
  assert.equal(app.saved.turns.length, 3);
  assert.equal(app.saved.turns[1].status, "interrupted");
  assert.equal(app.saved.turns[1].user.id, "unfinished:user");
  assert.equal(app.saved.turns[2].status, "pending");
  assert.equal(app.saved.turns[2].user.content, "A different question");
  assert.notEqual(app.saved.turns[2].user.id, "unfinished:user");
  const payload = JSON.parse(app.fetchCalls[0][1].body);
  assert.equal(payload.history.length, 2);
  stream.content("Different answer");
  stream.done();
  await send;
  await flush();
  assert.equal(app.saved.turns[2].status, "complete");
  assert.equal(app.state.error, "");
  app.unmount();
});

test("disabled storage keeps chat functional in memory and reports persistence failure", async () => {
  const app = mountChat({ storageUnavailable: true });
  await flush();
  assert.equal(app.state.ready, true);
  assert.match(app.state.error, /storage.*unavailable|cannot be read/i);
  await app.type("Hello");
  await app.state.askAI();
  await flush();
  assert.equal(app.state.conversation.turns[0].status, "complete");
  assert.equal(app.state.reply, "Answer");
  assert.match(app.state.error, /storage.*unavailable|cannot be read/i);
  assert.equal(app.writes.length, 0);
  app.unmount();
});

test("storage becoming unavailable during streaming preserves the completed answer in memory", async () => {
  const app = mountChat();
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Hello");
  const send = app.state.askAI();
  await flush();
  app.browser.failRead = true;
  app.browser.failWrite = true;
  stream.content("Complete answer");
  stream.done();
  await send;
  await flush();
  assert.equal(app.state.conversation.turns[0].status, "complete");
  assert.equal(app.state.conversation.turns[0].assistant.content, "Complete answer");
  assert.match(app.state.error, /storage|history/i);
  app.unmount();
});

test("outgoing context is a bounded recent suffix while saved history stays intact", async () => {
  const turns = Array.from({ length: 55 }, (_, index) => completeTurn(`turn-${index}`, `Question ${index}`, `Answer ${index}`));
  const app = mountChat({ saved: savedConversation(turns) });
  await flush();
  await app.type("Next");
  await app.state.askAI();
  const payload = JSON.parse(app.fetchCalls[0][1].body);
  assert.equal(payload.history.length, 100);
  assert.equal(payload.history[0].content, "Question 5");
  assert.equal(payload.history.at(-1).content, "Answer 54");
  assert.equal(app.saved.turns.length, 56);
  app.unmount();
});

test("oversized UTF-8 messages are rejected without losing the draft or adding a turn", async () => {
  const app = mountChat();
  await flush();
  const text = "🙂".repeat(5000);
  await app.type(text);
  await app.state.askAI();
  await flush();
  assert.equal(app.fetchCalls.length, 0);
  assert.equal(app.state.message, text);
  assert.equal(app.saved.turns.length, 0);
  assert.match(app.state.error, /too long/);
  app.unmount();
});

test("a busy browser lock preserves the draft without adding or submitting a turn", async () => {
  const app = mountChat({ locks: { request: async (_name, _options, callback) => callback(null) } });
  await flush();
  await app.type("Hello");
  await app.state.askAI();
  await flush();
  assert.equal(app.fetchCalls.length, 0);
  assert.equal(app.saved.turns.length, 0);
  assert.equal(app.state.message, "Hello");
  assert.equal(app.state.loading, false);
  assert.match(app.state.error, /another tab/);
  app.unmount();
});

test("corrupt history is preserved until the user explicitly clears it", async () => {
  const app = mountChat({ saved: "{corrupt" });
  await flush();
  assert.match(app.state.error, /invalid/);
  await app.type("Temporary conversation");
  await app.state.askAI();
  await flush();
  assert.equal(app.state.conversation.turns[0].status, "complete");
  assert.equal(app.rawSaved, "{corrupt");
  app.state.clearConversation();
  await flush();
  assert.deepEqual(app.saved.turns, []);
  assert.equal(app.state.error, "");
  app.unmount();
});

test("explicit clear repairs a corrupt browser identity and the new conversation survives reload", async () => {
  const app = mountChat({ storageEntries: [["chat-context:owner:v1", "invalid/identity"]] });
  await flush();
  assert.match(app.state.error, /identity.*invalid/i);
  app.state.clearConversation();
  await flush();
  const cleared = plain(app.state.conversation);
  assert.equal(app.state.error, "");
  assert.deepEqual(cleared.turns, []);
  const storageEntries = app.snapshotStorage();
  assert.equal(new Map(storageEntries).get("chat-context:owner:v1"), cleared.ownerId);
  app.unmount();

  const reloaded = mountChat({ storageEntries });
  await flush();
  assert.deepEqual(plain(reloaded.state.conversation), cleared);
  assert.equal(reloaded.state.error, "");
  assert.equal(reloaded.writes.length, 0);
  reloaded.unmount();
});

test("unmount aborts and prevents a late stream from committing history", async () => {
  const app = mountChat();
  await flush();
  const stream = streamResponse();
  app.setFetch(async () => stream.response);
  await app.type("Hello");
  const send = app.state.askAI();
  await flush();
  app.unmount();
  const writeCount = app.writes.length;
  assert.equal(app.fetchCalls[0][1].signal.aborted, true);
  stream.content("Late");
  stream.done();
  await send;
  assert.equal(app.writes.length, writeCount);
  assert.equal(app.saved.turns[0].status, "pending");
});
