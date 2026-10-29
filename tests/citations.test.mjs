import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCitations, resolveCitations } from "../app/lib/chat-context/citations.ts";
import { readChatStream } from "../app/lib/read-chat-stream.ts";

function citation(overrides = {}) {
  return { label: "[S1]", documentId: "real-document", chunkId: "real-chunk", sourceName: "03_API_Guide.pdf", pageNumber: 3, ...overrides };
}
function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
}
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content) => event({ choices: [{ delta: { content } }] });

test("only markers in this response's source metadata resolve, in first-mentioned order", () => {
  const sources = [citation(), citation({ label: "[S5]", chunkId: "chunk-5", pageNumber: 7 }), citation({ label: "[S2]" })];
  assert.deepEqual(resolveCitations("Answer [S5] then [S1], repeated [S5], fabricated [S99].", sources), [sources[1], sources[0]]);
  assert.deepEqual(resolveCitations("Answer [S99]", sources), []);
  assert.deepEqual(resolveCitations("No citations", sources), []);
});

test("filenames are derived from real metadata without turning paths into public URLs", () => {
  for (const sourceName of ["taskflow/03_API_Guide.pdf", "A:\\private\\taskflow\\03_API_Guide.pdf", "/private/docs/03_API_Guide.pdf"]) {
    assert.deepEqual(resolveCitations("Answer [S1]", [citation({ sourceName, url: "https://invented.invalid", text: "private passage" })]), [citation()]);
  }
});

test("response-local labels can identify different real documents across answers", () => {
  const first = citation();
  const second = citation({ documentId: "other-document", chunkId: "other-chunk", sourceName: "Billing.pdf", pageNumber: 2 });
  assert.deepEqual(resolveCitations("First [S1]", [first]), [first]);
  assert.deepEqual(resolveCitations("Second [S1]", [second]), [second]);
});

test("missing or malformed metadata is ignored safely", () => {
  for (const value of [undefined, null, {}, "[S1]", Array(1001).fill(citation())]) assert.deepEqual(parseCitations(value), []);
  for (const bad of [null, {}, citation({ label: "[S0]" }), citation({ label: "[S01]" }), citation({ label: "[S1001]" }),
    citation({ label: "S1" }), citation({ pageNumber: 0 }), citation({ pageNumber: 1.5 }), citation({ pageNumber: "3" }),
    citation({ documentId: "" }), citation({ chunkId: "" }), citation({ sourceName: "private/" }),
    citation({ sourceName: ".." }), citation({ sourceName: "name\u0000.pdf" })]) {
    assert.deepEqual(parseCitations([bad, citation({ label: "[S2]" })]), [citation({ label: "[S2]" })]);
  }
});

test("identical duplicates collapse and conflicting mappings fail closed for that label", () => {
  const source = citation();
  assert.deepEqual(parseCitations([source, source]), [source]);
  assert.deepEqual(parseCitations([source, citation({ pageNumber: 99 }), source]), []);
});

test("unverified markers never gain metadata and inputs are not mutated", () => {
  const original = Object.freeze([Object.freeze(citation())]);
  assert.deepEqual(resolveCitations("[S01] [s1] [S9] [S0] [S1]", original), [citation()]);
  assert.deepEqual(original, [citation()]);
});

test("the existing parser preserves text and returns metadata across split UTF-8/SSE boundaries", async () => {
  const source = citation({ sourceName: "Керівництво.pdf" });
  const body = stream(delta("Привіт 🙂 [S") + delta("1]") + event({ type: "citations", citations: [source] }) + "data: [DONE]\n\n");
  let answer = "";
  const metadata = await readChatStream(body, (content) => { answer += content; });
  assert.equal(answer, "Привіт 🙂 [S1]");
  assert.deepEqual(resolveCitations(answer, metadata), [source]);
  assert.equal(body.locked, false);
});

test("legacy streams without metadata and invalid citation events still finish normally", async () => {
  for (const metadata of ["", event({ type: "citations", citations: { invalid: true } })]) {
    let text = "";
    const citations = await readChatStream(stream(delta("Answer [S1]") + metadata + "data: [DONE]\n\n"), (part) => { text += part; });
    assert.equal(text, "Answer [S1]");
    assert.deepEqual(citations, []);
  }
});

test("metadata never appears as answer text and is not committed before successful DONE", async () => {
  const received = [];
  await assert.rejects(() => readChatStream(stream(delta("Partial") + event({ type: "citations", citations: [citation()] })),
    (content) => received.push(content)), /ended unexpectedly/);
  assert.deepEqual(received, ["Partial"]);
});

test("a model's serialized citation-looking text cannot become a metadata event", async () => {
  const hostile = JSON.stringify({ type: "citations", citations: [citation({ sourceName: "Fake.pdf" })] });
  let text = "";
  const metadata = await readChatStream(stream(delta(hostile) + "data: [DONE]\n\n"), (part) => { text += part; });
  assert.equal(text, hostile);
  assert.deepEqual(metadata, []);
});
