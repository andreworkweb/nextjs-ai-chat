import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeText } from "../src/lib/rag/normalize-text.ts";

function page(text, metadata = {}) {
  return {
    documentId: "a".repeat(64),
    sourceName: "TaskFlow guide.md",
    pageNumber: 3,
    text,
    ...metadata,
  };
}

function normalized(text) {
  return normalizeText([page(text)])[0].text;
}

test("repeated horizontal whitespace becomes one space within prose", () => {
  assert.equal(normalized("TaskFlow   supports\t\tCSV. \nNext\u00a0\u00a0line.\t"), "TaskFlow supports CSV.\nNext line.");
});

test("paragraphs and single line breaks survive while excessive blank lines collapse", () => {
  const input = "\n\nFirst paragraph.\nMeaningful line break.\n\n \t\n\nSecond paragraph.\n\n\n";
  assert.equal(normalized(input), "First paragraph.\nMeaningful line break.\n\nSecond paragraph.");
});

test("CRLF, CR, Unicode line separators, and page breaks retain their boundaries", () => {
  const input = "One\r\nTwo\rThree\u0085Four\u2028Five\u2029Six\fSeven\vEight";
  assert.equal(normalized(input), "One\nTwo\nThree\nFour\nFive\n\nSix\n\nSeven\nEight");
});

test("unwanted C0 and C1 controls are removed without removing text", () => {
  const input = "Con\u0000trol\u0007\u001b text\u007f\u0080\u009f.\nStill\treadable.";
  assert.equal(normalized(input), "Control text.\nStill readable.");
});

test("punctuation, numbers, URLs, technical terms, and letter case remain unchanged", () => {
  const text = [
    "Price: $1,234.56; VAT 20%; delta -3.5e-4; version 2.4.5; date 2026-10-28.",
    "GET https://example.com/v1/files?id=42&format=csv#page-3",
    "text-embedding-3-small, @langchain/openai, Node.js, C++, C#, API_KEY, POST /exports.",
    "Don't de-hyphenate, lowercase, strip punctuation, or infer missing information.",
  ].join("\n");
  assert.equal(normalized(text), text);
});

test("line-ending hyphens and wrapped URLs are not joined or rewritten", () => {
  const text = "state-of-the-\nart\nhttps://example.com/\nv1?value=10";
  assert.equal(normalized(text), text);
});

test("Unicode letters, mathematical symbols, emoji, and joining characters are preserved", () => {
  const text = "Київ, café, 日本語, العربية, e\u0301; µ ≠ μ; ①; 👩\u200d💻; می\u200cروم";
  assert.equal(normalized(text), text);
});

test("Markdown headings, list indentation, hard breaks, and inline code are preserved", () => {
  const input = "#   TaskFlow\n\n-   Parent\n  -   Nested\nLine one.    \nLine two.\n`a  +  b` and  ``text with `ticks`  inside``";
  const expected = "# TaskFlow\n\n- Parent\n  - Nested\nLine one.  \nLine two.\n`a  +  b` and ``text with `ticks`  inside``";
  assert.equal(normalized(input), expected);
});

test("fenced code preserves spacing, blank lines, and string literals", () => {
  const code = [
    "```typescript",
    "const message = 'two  spaces';",
    "  const columns = [1,  2,  3];",
    "",
    "",
    "const template = `line one",
    "",
    "",
    "line four`;",
    "```",
  ].join("\n");
  assert.equal(normalized(`Before   code.\n\n\n${code}\n\n\nAfter   code.`), `Before code.\n\n${code}\n\nAfter code.`);
});

test("tilde fences and longer fences are closed only by a matching delimiter", () => {
  const text = "~~~~text\nkeep  spacing\n```\n~~~\nkeep  more\n~~~~";
  assert.equal(normalized(text), text);
  assert.equal(normalized("```text\nunclosed  code\n\n\n"), "```text\nunclosed  code\n\n\n");
});

test("indented code and aligned content keep their indentation and spacing", () => {
  const text = "    const label = 'two  spaces';\n\tconst values = [1,  2];\n  - Nested list";
  assert.equal(normalized(text), text);
});

test("blank lines inside indented code remain intact while surrounding paragraph gaps collapse", () => {
  const code = "    const template = `first\n\n    \n    fourth`;";
  assert.equal(normalized(`Before.\n\n\n${code}\n\n\nAfter.`), `Before.\n\n${code}\n\nAfter.`);
});

test("empty arrays, empty text, whitespace, and control-only pages are safe", () => {
  assert.deepEqual(normalizeText([]), []);
  const pages = [page(""), page(" \t\r\n\n"), page("\u0000\u0007\u009f"), page("\uFEFF")];
  const output = normalizeText(pages);
  assert.equal(output.length, 4);
  assert.deepEqual(output.map((entry) => entry.text), ["", "", "", ""]);
  assert.ok(output.every((entry) => entry.pageNumber === 3));
});

test("document IDs, source names, physical page order, and additional metadata stay intact", () => {
  const pages = [
    page("  \nFirst   page", { sourceName: "Original upload.pdf", pageNumber: 7, checksum: "original" }),
    page("", { sourceName: "Original upload.pdf", pageNumber: 8 }),
    page("Second   document", { documentId: "b".repeat(64), sourceName: "other.txt", pageNumber: 1 }),
  ];
  const output = normalizeText(pages);
  assert.deepEqual(output, [
    { ...pages[0], text: "First page" },
    { ...pages[1], text: "" },
    { ...pages[2], text: "Second document" },
  ]);
});

test("normalization never mutates the input array or page objects", () => {
  const pages = Object.freeze([
    Object.freeze(page("First   page")),
    Object.freeze(page("Already clean", { pageNumber: 4 })),
  ]);
  const snapshot = structuredClone(pages);
  const output = normalizeText(pages);
  assert.deepEqual(pages, snapshot);
  assert.notEqual(output, pages);
  for (let index = 0; index < pages.length; index++) assert.notEqual(output[index], pages[index]);
  output[0].text = "Edited independently";
  assert.equal(pages[0].text, "First   page");
});

test("normalization is idempotent for prose, Markdown, code, and empty pages", () => {
  const pages = [
    page("\nStart   here.\r\n\r\n\r\nNext   paragraph.\n"),
    page("-   Parent\n  -   Nested\nLine.    \nNext."),
    page("```text\n keep  spaces\n\n\n```\n\n\nEnd."),
    page(""),
  ];
  const once = normalizeText(pages);
  assert.deepEqual(normalizeText(once), once);
});

test("malformed inputs produce clear errors instead of silently losing text", () => {
  for (const input of [null, undefined, "text", {}]) {
    assert.throws(() => normalizeText(input), /Expected an array of ParsedPage objects/);
  }
  for (const input of [null, {}, page(null), page(42)]) {
    assert.throws(() => normalizeText([input]), /index 0 must contain a text string/);
  }
});
