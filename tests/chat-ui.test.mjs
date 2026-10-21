import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

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
