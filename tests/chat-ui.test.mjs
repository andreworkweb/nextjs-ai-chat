import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { documentPath, resolveCitations } from "../app/lib/chat-context/citations.ts";

const require = createRequire(import.meta.url);
const react = require("react");
const compiled = ts.transpileModule(
  readFileSync(new URL("../app/shared/chat.tsx", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
);

// Render the real presentation with chat snapshots. Conversation behavior is
// covered separately by the existing hook, storage, and API tests.
function renderChat(overrides = {}) {
  const state = {
    message: "",
    setMessage() {},
    reply: "",
    loading: false,
    ready: true,
    error: "",
    conversation: { turns: [] },
    askAI() {},
    clearConversation() {},
    ...overrides,
  };
  const loaded = { exports: {} };
  const localRequire = (id) => {
    if (id === "../lib/chat-context/use-chat") return { useChat: () => state };
    if (id === "../lib/chat-context/citations") return { documentPath, resolveCitations };
    if (id === "react") return {
      ...react,
      useEffect() {},
      useRef: () => ({ current: null }),
    };
    return require(id);
  };
  new Function("module", "exports", "require", compiled.outputText)(
    loaded, loaded.exports, localRequire,
  );
  return renderToStaticMarkup(react.createElement(loaded.exports.default));
}

function completeTurn(id, prompt, answer) {
  return {
    id,
    user: { id: `${id}:user`, role: "user", content: prompt },
    assistant: { id: `${id}:assistant`, role: "assistant", content: answer },
    status: "complete",
  };
}

test("the entire conversation renders chronologically in a single message log", () => {
  const html = renderChat({
    conversation: {
      turns: [
        completeTurn("first", "Remember blue", "I remember blue"),
        completeTurn("second", "Which color?", "The color is blue"),
      ],
    },
    reply: "The color is blue",
  });
  const messages = ["Remember blue", "I remember blue", "Which color?", "The color is blue"];
  const positions = messages.map((text) => html.indexOf(text));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, positions.toSorted((left, right) => left - right));
  for (const text of messages) assert.equal(html.split(text).length - 1, 1);
  assert.equal(html.match(/role="log"/g)?.length, 1);
  assert.equal(html.match(/<li /g)?.length, 4);
  assert.ok(html.indexOf("<form") > html.indexOf("</ol>"));
});

test("streaming a reply preserves previous messages and displays the current prompt", () => {
  const html = renderChat({
    conversation: {
      turns: [
        completeTurn("first", "Remember blue", "I remember blue"),
        { id: "next", user: { id: "next:user", content: "Which color?" }, status: "pending" },
      ],
    },
    loading: true,
    reply: "The color is",
  });
  for (const text of ["Remember blue", "I remember blue", "Which color?", "The color is"]) {
    assert.equal(html.split(text).length - 1, 1);
  }
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-label="Generating response"/);
});

test("waiting for the first streamed chunk shows feedback without repeating an old answer", () => {
  const html = renderChat({
    conversation: {
      turns: [{ id: "next", user: { id: "next:user", content: "Hello" }, status: "pending" }],
    },
    loading: true,
  });
  assert.match(html, /Hello/);
  assert.match(html, /Thinking…/);
});

test("recovered interrupted turns do not show the previous reply as their answer", () => {
  const html = renderChat({
    conversation: {
      turns: [
        completeTurn("first", "Remember blue", "I remember blue"),
        { id: "next", user: { id: "next:user", content: "Finish this" }, status: "interrupted" },
      ],
    },
    reply: "I remember blue",
    error: "A response could not be completed.",
  });
  assert.equal(html.split("I remember blue").length - 1, 1);
  assert.match(html, /Finish this/);
  assert.match(html, /Response interrupted/);
  assert.match(html, /role="alert"/);
  assert.match(html, /A response could not be completed/);
});

test("empty and restoring conversations keep the composer available with honest status", () => {
  const empty = renderChat();
  assert.match(empty, /Send a message to start a conversation/);
  assert.match(empty, /<textarea/);
  assert.match(empty, /aria-label="Send message"/);
  assert.doesNotMatch(empty, /role="log"/);

  const restoring = renderChat({ ready: false, conversation: null });
  assert.match(restoring, /Loading your conversation…/);
  assert.match(restoring, /<button[^>]*disabled=""[^>]*aria-label="Send message"/);
});

test("each assistant renders its own verified filename and page beneath the answer", () => {
  const first = completeTurn("first", "API limit?", "60 requests [S1].");
  first.assistant.citations = [{ label: "[S1]", documentId: "api-doc", chunkId: "api-chunk", sourceName: "private/03_API_Guide.pdf", pageNumber: 3 }];
  const second = completeTurn("second", "Refunds?", "Annual refund policy [S1].");
  second.assistant.citations = [{ label: "[S1]", documentId: "billing-doc", chunkId: "billing-chunk", sourceName: "02_Plans_and_Billing.pdf", pageNumber: 2 }];
  const html = renderChat({ conversation: { turns: [first, second] } });
  assert.equal(html.match(/aria-label="Sources for this answer"/g)?.length, 2);
  assert.match(html, /03_API_Guide.pdf/);
  assert.match(html, /Page 3/);
  assert.match(html, /02_Plans_and_Billing.pdf/);
  assert.match(html, /Page 2/);
  assert.ok(html.indexOf("60 requests") < html.indexOf("03_API_Guide.pdf"));
  assert.ok(html.indexOf("03_API_Guide.pdf") < html.indexOf("Refunds?"));
  assert.ok(html.indexOf("Annual refund policy") < html.indexOf("02_Plans_and_Billing.pdf"));
  assert.doesNotMatch(html, /private\/|href=|api-chunk|billing-doc/);
});

test("missing, invalid, or unused citation metadata never creates a source panel", () => {
  const turn = completeTurn("first", "Question", "Unknown [S99].");
  for (const citations of [undefined, [{ label: "[S1]", documentId: "doc", chunkId: "chunk", sourceName: "Unused.pdf", pageNumber: 1 }],
    [{ label: "[S99]", documentId: "doc", chunkId: "chunk", sourceName: "Invalid.pdf", pageNumber: 0 }]]) {
    turn.assistant.citations = citations;
    const html = renderChat({ conversation: { turns: [turn] } });
    assert.match(html, /Unknown \[S99\]/);
    assert.doesNotMatch(html, /Sources for this answer|Unused.pdf|Invalid.pdf/);
  }
});

test("source names render as escaped plain text, never HTML or document links", () => {
  const turn = completeTurn("first", "Question", "Answer [S1].");
  turn.assistant.citations = [{ label: "[S1]", documentId: "doc", chunkId: "chunk", sourceName: '<img onerror="alert(1)">.pdf', pageNumber: 1 }];
  const html = renderChat({ conversation: { turns: [turn] } });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|href=/);
});

test("accessible PDF citations link to the ID route and cited page in a protected new tab", () => {
  const id = "6e88c38545db0c9edf1a023928a50c36edb5e583aeec4690155da6986b7f106d";
  const turn = completeTurn("first", "API?", "Answer [S1].");
  turn.assistant.citations = [{ label: "[S1]", documentId: id, chunkId: "real-chunk", sourceName: "03_API_Guide.pdf", pageNumber: 3 }];
  const html = renderChat({ conversation: { turns: [turn] }, documentAvailability: { [id]: true } });
  assert.ok(html.includes(`href="/api/documents/${id}#page=3"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Open 03_API_Guide.pdf, page 3 \(new tab\)/);
});

test("missing, denied, and not-yet-checked PDF sources stay readable without broken links", () => {
  const id = "a".repeat(64);
  const turn = completeTurn("first", "Question", "Answer [S1].");
  turn.assistant.citations = [{ label: "[S1]", documentId: id, chunkId: "chunk", sourceName: "Guide.pdf", pageNumber: 2 }];
  for (const documentAvailability of [{}, { [id]: false }]) {
    const html = renderChat({ conversation: { turns: [turn] }, documentAvailability });
    assert.match(html, /Guide.pdf · Page 2/);
    assert.doesNotMatch(html, /href=|target="_blank"/);
  }
  turn.assistant.citations[0].documentId = "../../private.pdf";
  const html = renderChat({ conversation: { turns: [turn] }, documentAvailability: { "../../private.pdf": true } });
  assert.doesNotMatch(html, /href=/);
});
