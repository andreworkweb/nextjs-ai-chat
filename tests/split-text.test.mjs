import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { extractText } from "../src/lib/rag/extract-text.ts";
import { normalizeText } from "../src/lib/rag/normalize-text.ts";
import { splitText } from "../src/lib/rag/split-text.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const originalEnvironment = {
  RAG_CHUNK_SIZE: process.env.RAG_CHUNK_SIZE,
  RAG_CHUNK_OVERLAP: process.env.RAG_CHUNK_OVERLAP,
};

beforeEach(() => {
  delete process.env.RAG_CHUNK_SIZE;
  delete process.env.RAG_CHUNK_OVERLAP;
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function page(text, metadata = {}) {
  return {
    documentId: "a".repeat(64),
    sourceName: "TaskFlow guide.pdf",
    pageNumber: 3,
    text,
    ...metadata,
  };
}

// No separators and no repeated 200-character blocks: the fallback must preserve
// these exact slices rather than accidentally matching a repeated filler word.
const longText = Array.from({ length: 625 }, (_, index) => index.toString(16).padStart(4, "0")).join("");

test("default chunks are at most 1000 characters with a 200-character overlap", async () => {
  const chunks = await splitText([page(longText)]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    longText.slice(0, 1000),
    longText.slice(800, 1800),
    longText.slice(1600),
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.text.length), [1000, 1000, 900]);
  for (let index = 1; index < chunks.length; index++) {
    assert.equal(chunks[index - 1].text.slice(-200), chunks[index].text.slice(0, 200));
  }
  const reconstructed = chunks[0].text + chunks.slice(1).map((chunk) => chunk.text.slice(200)).join("");
  assert.equal(reconstructed, longText);
});

test("custom size and overlap are honored without losing source text", async () => {
  const text = longText.slice(0, 230);
  const chunks = await splitText([page(text)], { chunkSize: 80, chunkOverlap: 20 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    text.slice(0, 80), text.slice(60, 140), text.slice(120, 200), text.slice(180),
  ]);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 80));
  for (let index = 1; index < chunks.length; index++) {
    assert.equal(chunks[index - 1].text.slice(-20), chunks[index].text.slice(0, 20));
  }
});

test("zero overlap produces adjacent chunks and supports a one-character size", async () => {
  const text = longText.slice(0, 235);
  const chunks = await splitText([page(text)], { chunkSize: 80, chunkOverlap: 0 });
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  assert.deepEqual(chunks.map((chunk) => chunk.text.length), [80, 80, 75]);
  assert.deepEqual((await splitText([page("ABC")], { chunkSize: 1, chunkOverlap: 0 })).map((chunk) => chunk.text), ["A", "B", "C"]);
});

test("environment variables configure sizes and explicit options take precedence", async () => {
  process.env.RAG_CHUNK_SIZE = "80";
  process.env.RAG_CHUNK_OVERLAP = "20";
  const text = longText.slice(0, 230);
  const chunks = await splitText([page(text)]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    text.slice(0, 80), text.slice(60, 140), text.slice(120, 200), text.slice(180),
  ]);
  const overridden = await splitText([page(text)], { chunkSize: 100, chunkOverlap: 0 });
  assert.deepEqual(overridden.map((chunk) => chunk.text.length), [100, 100, 30]);

  process.env.RAG_CHUNK_SIZE = "invalid";
  process.env.RAG_CHUNK_OVERLAP = "invalid";
  assert.deepEqual(await splitText([page(text)], { chunkSize: 100, chunkOverlap: 0 }), overridden);
});

test("paragraph boundaries take precedence over shorter sentence and word boundaries", async () => {
  const paragraphs = [
    "First paragraph keeps this sentence together.",
    "Second paragraph preserves its own context.",
    "Third paragraph remains a complete passage.",
  ];
  const chunks = await splitText([page(paragraphs.join("\n\n"))], { chunkSize: 75, chunkOverlap: 0 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), paragraphs);
});

test("sentence boundaries retain periods, question marks, and exclamation marks", async () => {
  for (const punctuation of [".", "?", "!"]) {
    const sentences = [
      `Alpha sentence has detail${punctuation}`,
      `Beta sentence carries context${punctuation}`,
      `Gamma sentence stays complete${punctuation}`,
    ];
    const chunks = await splitText([page(sentences.join(" "))], { chunkSize: 45, chunkOverlap: 0 });
    assert.deepEqual(chunks.map((chunk) => chunk.text), sentences);
  }
});

test("boundary-based overlap is a target and does not force unrelated paragraphs together", async () => {
  const first = "First paragraph has one complete sentence.";
  const second = "Second paragraph is independent context.";
  const chunks = await splitText([page(`${first}\n\n${second}`)], { chunkSize: 60, chunkOverlap: 15 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), [first, second]);
});

test("technical terms, URLs, numbers, and Unicode content survive intact in short pages", async () => {
  const text = "text-embedding-3-small; C++; @langchain/openai; $1,234.56; GET https://example.com/v1?id=42#ref; Київ, café, 日本語, 👩‍💻.";
  const chunks = await splitText([page(text)]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
});

test("character fallback never splits Unicode pairs at a chunk boundary", async () => {
  const text = `${"a".repeat(49)}🙂${"b".repeat(29)}🚀`;
  const chunks = await splitText([page(text)], { chunkSize: 50, chunkOverlap: 0 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 50 && chunk.text.isWellFormed()));
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  await assert.rejects(splitText([page("🙂")], { chunkSize: 1, chunkOverlap: 0 }), /chunkSize must be at least 2/);
});

test("each page is split separately and citation metadata and page order stay intact", async () => {
  const pages = [
    page(longText.slice(0, 180), { pageNumber: 7, checksum: "source-checksum" }),
    page("", { pageNumber: 8 }),
    page("The next physical page.", { pageNumber: 9 }),
    page("A second document.", { documentId: "b".repeat(64), sourceName: "other.txt", pageNumber: 1 }),
  ];
  const chunks = await splitText(pages, { chunkSize: 80, chunkOverlap: 20 });
  assert.deepEqual(chunks.map((chunk) => chunk.pageNumber), [7, 7, 7, 9, 1]);
  assert.deepEqual(chunks.map((chunk) => chunk.chunkIndex), [0, 1, 2, 0, 0]);
  for (const chunk of chunks) {
    const source = pages.find((entry) => entry.documentId === chunk.documentId && entry.pageNumber === chunk.pageNumber);
    assert.ok(source);
    assert.equal(chunk.sourceName, source.sourceName);
    assert.ok(source.text.includes(chunk.text));
    assert.equal(chunk.checksum, source.checksum);
    assert.match(chunk.id, uuid);
  }
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
});

test("blank pages, whitespace-only pages, and empty arrays do not create empty chunks", async () => {
  assert.deepEqual(await splitText([]), []);
  assert.deepEqual(await splitText([page(""), page(" \t\n\n"), page("\uFEFF")]), []);
  const chunks = await splitText([page(""), page("Kept", { pageNumber: 5 }), page("\n")]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Kept");
  assert.equal(chunks[0].pageNumber, 5);
  assert.equal(chunks[0].chunkIndex, 0);
});

test("chunk IDs and indexes are deterministic on repeated runs", async () => {
  const pages = [page(longText)];
  const first = await splitText(pages);
  assert.deepEqual(await splitText(pages), first);
  assert.deepEqual(first.map((chunk) => chunk.chunkIndex), [0, 1, 2]);
  assert.ok(first.every((chunk) => uuid.test(chunk.id)));
});

test("IDs remain stable when source names change or pages are batched differently", async () => {
  const original = page(longText);
  const alone = await splitText([original]);
  const renamed = await splitText([{ ...original, sourceName: "Renamed file.pdf" }]);
  assert.deepEqual(renamed.map((chunk) => chunk.id), alone.map((chunk) => chunk.id));
  const extraPage = page("Other page", { pageNumber: 99 });
  const batched = await splitText([extraPage, original]);
  assert.deepEqual(batched.filter((chunk) => chunk.pageNumber === 3), alone);
});

test("document, page, position, and text distinguish otherwise similar chunk IDs", async () => {
  const original = (await splitText([page("Same text")]))[0];
  const changedDocument = (await splitText([page("Same text", { documentId: "b".repeat(64) })]))[0];
  const changedPage = (await splitText([page("Same text", { pageNumber: 4 })]))[0];
  const changedText = (await splitText([page("Changed text")]))[0];
  assert.equal(new Set([original.id, changedDocument.id, changedPage.id, changedText.id]).size, 4);

  const repeated = await splitText([page("A".repeat(2600))]);
  assert.equal(repeated[0].text, repeated[1].text);
  assert.notEqual(repeated[0].id, repeated[1].id);
  assert.equal(new Set(repeated.map((chunk) => chunk.id)).size, repeated.length);
});

test("normalization and splitting compose without changing the input pages", async () => {
  const pages = Object.freeze([Object.freeze(page("First   paragraph.\r\n\r\n\r\nNext   paragraph."))]);
  const snapshot = structuredClone(pages);
  const normalized = normalizeText(pages);
  const frozen = Object.freeze(normalized.map((entry) => Object.freeze(entry)));
  const chunks = await splitText(frozen);
  assert.equal(chunks[0].text, "First paragraph.\n\nNext paragraph.");
  assert.deepEqual(pages, snapshot);
  assert.notEqual(chunks[0], frozen[0]);
});

test("Step 1 PDFs and text fixtures extract, normalize, and split into valid searchable chunks", async (t) => {
  const files = [
    ...["01_Product_Guide.pdf", "02_Plans_and_Billing.pdf", "03_API_Guide.pdf", "04_Troubleshooting.pdf", "05_Release_Notes.pdf"]
      .map((file) => path.join(root, "public/documents/taskflow", file)),
    path.join(root, "tests/fixtures/rag/sample.txt"),
    path.join(root, "tests/fixtures/rag/sample.md"),
  ];
  for (const file of files) {
    await t.test(path.basename(file), async () => {
      const bytes = await readFile(file);
      const pages = await extractText(file);
      const chunks = await splitText(pages);
      assert.ok(chunks.length > 0);
      assert.deepEqual(JSON.parse(JSON.stringify(chunks)), chunks);
      assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
      const counts = new Map();
      for (const chunk of chunks) {
        assert.match(chunk.id, uuid);
        assert.ok(chunk.text.trim().length > 0 && chunk.text.length <= 1000);
        const source = pages.find((entry) => entry.pageNumber === chunk.pageNumber);
        assert.ok(source);
        assert.equal(chunk.documentId, source.documentId);
        assert.equal(chunk.sourceName, source.sourceName);
        assert.ok(source.text.includes(chunk.text));
        const count = counts.get(chunk.pageNumber) ?? 0;
        assert.equal(chunk.chunkIndex, count);
        counts.set(chunk.pageNumber, count + 1);
      }
      assert.deepEqual([...counts.keys()], pages.filter((entry) => entry.text.trim()).map((entry) => entry.pageNumber));
      if (path.extname(file) === ".pdf") assert.ok(chunks.length > pages.length);
      assert.deepEqual(await readFile(file), bytes);
    });
  }
});

test("invalid chunk sizes and overlaps produce meaningful errors", async () => {
  for (const chunkSize of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    await assert.rejects(splitText([page("Text")], { chunkSize, chunkOverlap: 0 }), /chunkSize must be a positive safe integer/);
  }
  for (const chunkOverlap of [-1, 1.5, NaN, Infinity, 100, 101, "20", null]) {
    await assert.rejects(splitText([page("Text")], { chunkSize: 100, chunkOverlap }), /chunkOverlap must be a non-negative safe integer smaller than chunkSize/);
  }
});

test("invalid environment settings are rejected instead of silently falling back", async () => {
  for (const value of ["", " ", "abc", "1.5", "1e3", "-1", "10px"]) {
    process.env.RAG_CHUNK_SIZE = value;
    await assert.rejects(splitText([page("Text")]), /RAG_CHUNK_SIZE must be a non-negative decimal integer/);
  }
  process.env.RAG_CHUNK_SIZE = "0";
  await assert.rejects(splitText([page("Text")]), /chunkSize must be a positive safe integer/);
  process.env.RAG_CHUNK_SIZE = "9007199254740992";
  await assert.rejects(splitText([page("Text")]), /chunkSize must be a positive safe integer/);
  process.env.RAG_CHUNK_SIZE = "1000";
  process.env.RAG_CHUNK_OVERLAP = "invalid";
  await assert.rejects(splitText([page("Text")]), /RAG_CHUNK_OVERLAP must be a non-negative decimal integer/);
  process.env.RAG_CHUNK_OVERLAP = "1000";
  await assert.rejects(splitText([page("Text")]), /smaller than chunkSize/);
});

test("invalid page arrays and options are rejected with context", async () => {
  for (const input of [null, undefined, "Text", {}]) {
    await assert.rejects(splitText(input), /Expected an array of normalized ParsedPage objects/);
  }
  for (const options of [null, "options", []]) {
    await assert.rejects(splitText([page("Text")], options), /Chunking options must be an object/);
  }
  for (const entry of [null, {}, page(null), page(42)]) {
    await assert.rejects(splitText([entry]), /index 0 must contain a text string/);
  }
  for (const metadata of [
    { documentId: "" }, { documentId: null }, { sourceName: " " }, { sourceName: 42 },
    { pageNumber: 0 }, { pageNumber: -1 }, { pageNumber: 1.5 }, { pageNumber: "3" },
  ]) {
    await assert.rejects(splitText([page("Text", metadata)]), /index 0 requires documentId, sourceName, and a positive integer pageNumber/);
  }
});

test("unexpected splitter errors identify the source page and retain the cause", async (t) => {
  const failure = new Error("Unexpected splitter failure");
  t.mock.method(RecursiveCharacterTextSplitter.prototype, "splitText", async () => { throw failure; });
  await assert.rejects(splitText([page("Text")]), (error) => {
    assert.match(error.message, /Unable to split page 3 of "TaskFlow guide.pdf"/);
    assert.equal(error.cause, failure);
    return true;
  });
});
