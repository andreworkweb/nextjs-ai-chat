import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PDFParse, PasswordException } from "pdf-parse";
import { DocumentExtractionError, extractText } from "../src/lib/rag/extract-text.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "tests/fixtures/rag");
const documents = path.join(root, "public/documents/taskflow");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "rag-extraction-"));
});

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

async function temporaryFile(name, contents) {
  const file = path.join(temporaryDirectory, name);
  await writeFile(file, contents);
  return file;
}

function expectError(code, message) {
  return (error) => {
    assert.ok(error instanceof DocumentExtractionError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  };
}

// Small, real PDFs with a valid cross-reference table. These exercise the actual
// parser for blank/image-only/mixed pages without adding a PDF-writing package.
function makePdf(pageStreams) {
  const image = "FF0000>\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}endstream`,
  ];
  const pageReferences = [];
  for (const stream of pageStreams) {
    const pageNumber = objects.length + 1;
    pageReferences.push(`${pageNumber} 0 R`);
    const body = `${stream}\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`,
      `<< /Length ${body.length} >>\nstream\n${body}endstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageReferences.join(" ")}] /Count ${pageStreams.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const crossReferenceOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("TXT extraction preserves UTF-8 text, source name, and page metadata", async () => {
  const file = path.join(fixtures, "sample.txt");
  const bytes = await readFile(file);
  assert.deepEqual(await extractText(file), [{
    documentId: hash(bytes),
    sourceName: "sample.txt",
    pageNumber: 1,
    text: bytes.toString("utf8"),
  }]);
  assert.match((await extractText(file))[0].text, /Київ, café, 日本語, 🙂/);
});

test("Markdown extraction preserves headings, lists, code fences, and whitespace", async () => {
  const file = path.join(fixtures, "sample.md");
  const [page] = await extractText(file);
  assert.equal(page.text, await readFile(file, "utf8"));
  assert.equal(page.sourceName, "sample.md");
  assert.equal(page.pageNumber, 1);
  assert.match(page.text, /# TaskFlow export notes/);
  assert.match(page.text, /```text\r?\nPOST \/exports\r?\n```/);

  const indented = "    indented code\r\n\r\n- list item\r\n";
  assert.equal((await extractText(await temporaryFile("indented.md", indented)))[0].text, indented);
});

test("uppercase extensions and .markdown are supported", async () => {
  for (const extension of ["TXT", "MD", "MARKDOWN"]) {
    const file = await temporaryFile(`uppercase.${extension}`, "# Text content\n");
    assert.equal((await extractText(file))[0].text, "# Text content\n");
  }
});

test("a UTF-8 BOM is decoded while documentId still hashes the original bytes", async () => {
  const bytes = Buffer.from("\uFEFFHello, TaskFlow\n", "utf8");
  const [page] = await extractText(await temporaryFile("bom.txt", bytes));
  assert.equal(page.text, "Hello, TaskFlow\n");
  assert.equal(page.documentId, hash(bytes));
});

test("documentId is stable across repeated reads, names, and paths and changes with content", async () => {
  const original = path.join(fixtures, "sample.txt");
  const renamed = path.join(temporaryDirectory, "renamed.md");
  await copyFile(original, renamed);
  const [first] = await extractText(original);
  assert.match(first.documentId, /^[a-f0-9]{64}$/);
  assert.equal((await extractText(original))[0].documentId, first.documentId);
  assert.equal((await extractText(renamed))[0].documentId, first.documentId);
  const [custom] = await extractText(renamed, "Original upload.txt");
  assert.equal(custom.sourceName, "Original upload.txt");
  assert.equal(custom.documentId, first.documentId);
  await writeFile(renamed, "Changed content");
  assert.notEqual((await extractText(renamed))[0].documentId, first.documentId);
});

test("all Step 1 PDFs extract with their physical page numbers and unchanged originals", async (t) => {
  const files = [
    "01_Product_Guide.pdf",
    "02_Plans_and_Billing.pdf",
    "03_API_Guide.pdf",
    "04_Troubleshooting.pdf",
    "05_Release_Notes.pdf",
  ];
  const parsed = new Map();
  for (const name of files) {
    await t.test(name, async () => {
      const file = path.join(documents, name);
      const original = await readFile(file);
      const pages = await extractText(file);
      assert.equal(pages.length, 4);
      for (const [index, page] of pages.entries()) {
        assert.equal(page.documentId, hash(original));
        assert.equal(page.sourceName, name);
        assert.equal(page.pageNumber, index + 1);
        assert.match(page.text, /TaskFlow/i);
        assert.match(page.text, new RegExp(`Page ${index + 1} of 4`));
      }
      assert.deepEqual(await readFile(file), original);
      parsed.set(name, pages);
    });
  }

  const questions = JSON.parse(await readFile(path.join(fixtures, "taskflow-questions.json"), "utf8"));
  for (const { sources } of questions) {
    for (const { file, page } of sources) {
      const source = parsed.get(file)?.find((entry) => entry.pageNumber === page);
      assert.ok(source?.text.trim(), `Missing Step 1 source: ${file}, page ${page}`);
    }
  }
  assert.match(parsed.get("01_Product_Guide.pdf")[2].text, /CSV/);
  assert.match(parsed.get("03_API_Guide.pdf")[2].text, /\/exports/);
});

test("mixed PDFs retain blank pages and never renumber later text pages", async () => {
  const bytes = makePdf([
    "BT /F1 12 Tf 32 700 Td (First page) Tj ET",
    "",
    "BT /F1 12 Tf 32 700 Td (Third page) Tj ET",
  ]);
  const file = await temporaryFile("mixed.pdf", bytes);
  const pages = await extractText(file, "Uploaded PDF");
  assert.deepEqual(pages.map((page) => [page.pageNumber, page.text]), [
    [1, "First page"], [2, ""], [3, "Third page"],
  ]);
  assert.ok(pages.every((page) => page.documentId === hash(bytes) && page.sourceName === "Uploaded PDF"));
  assert.equal((await extractText(file))[0].documentId, pages[0].documentId);
  assert.deepEqual(await readFile(file), bytes);
});

test("blank and image-only PDFs report that OCR may be required", async () => {
  for (const [name, stream] of [
    ["blank.pdf", ""],
    ["image-only.pdf", "q 100 0 0 100 32 32 cm /Im1 Do Q"],
  ]) {
    const file = await temporaryFile(name, makePdf([stream]));
    await assert.rejects(extractText(file), expectError("OCR_REQUIRED", /no extractable text.*OCR may be required/));
  }
});

test("invalid paths and source names produce input errors", async () => {
  for (const file of [null, undefined, 42, "", "   ", "bad\0path.txt"]) {
    await assert.rejects(extractText(file), expectError("INVALID_INPUT", /file path/));
  }
  for (const name of [null, 42, "", "   "]) {
    await assert.rejects(extractText(path.join(fixtures, "sample.txt"), name), expectError("INVALID_INPUT", /sourceName/));
  }
});

test("unsupported extensions, missing files, and directories produce meaningful errors", async () => {
  for (const name of ["sample.docx", "sample.exe", "sample"]) {
    await assert.rejects(extractText(name), expectError("UNSUPPORTED_FILE_TYPE", /Supported types: PDF, TXT, and Markdown/));
  }
  await assert.rejects(extractText(path.join(temporaryDirectory, "missing.txt")), expectError("FILE_READ_FAILED", /File not found/));
  const directory = path.join(temporaryDirectory, "directory.txt");
  await mkdir(directory);
  await assert.rejects(extractText(directory), expectError("FILE_READ_FAILED", /Unable to read/));
});

test("zero-byte and whitespace-only documents are rejected", async () => {
  for (const extension of ["txt", "md", "pdf"]) {
    const file = await temporaryFile(`empty.${extension}`, "");
    await assert.rejects(extractText(file), expectError("EMPTY_FILE", /empty/));
  }
  const file = await temporaryFile("whitespace.md", "\uFEFF \t\r\n");
  await assert.rejects(extractText(file), expectError("EMPTY_FILE", /only whitespace/));
});

test("invalid UTF-8 and binary data masquerading as text are rejected", async () => {
  const invalid = await temporaryFile("invalid.txt", Buffer.from([0xc3, 0x28]));
  await assert.rejects(extractText(invalid), expectError("INVALID_TEXT", /not valid UTF-8/));
  const binary = await temporaryFile("binary.md", Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(extractText(binary), expectError("INVALID_TEXT", /binary data/));
});

test("renamed text and corrupt PDFs produce PDF errors rather than OCR errors", async () => {
  const renamed = await temporaryFile("not-a-pdf.pdf", "This is plain text.");
  await assert.rejects(extractText(renamed), expectError("INVALID_PDF", /PDF header is missing/));
  const corrupt = await temporaryFile("corrupt.pdf", "%PDF-1.7\ninvalid objects\n%%EOF");
  await assert.rejects(extractText(corrupt), expectError("PDF_PARSE_FAILED", /invalid or corrupted/));
});

test("PDF parsers are destroyed after success, OCR detection, and corruption", async (t) => {
  const destroy = t.mock.method(PDFParse.prototype, "destroy");
  await extractText(path.join(documents, "01_Product_Guide.pdf"));
  assert.equal(destroy.mock.callCount(), 1);
  const imageOnly = await temporaryFile("cleanup-image.pdf", makePdf(["q 100 0 0 100 32 32 cm /Im1 Do Q"]));
  await assert.rejects(extractText(imageOnly), expectError("OCR_REQUIRED", /OCR/));
  assert.equal(destroy.mock.callCount(), 2);
  const corrupt = await temporaryFile("cleanup-corrupt.pdf", "%PDF-1.7\ninvalid objects\n%%EOF");
  await assert.rejects(extractText(corrupt), expectError("PDF_PARSE_FAILED", /corrupted/));
  assert.equal(destroy.mock.callCount(), 3);
});

test("PDF password errors are actionable and still destroy the parser", async (t) => {
  t.mock.method(PDFParse.prototype, "getText", async () => {
    throw new PasswordException("Password required");
  });
  const destroy = t.mock.method(PDFParse.prototype, "destroy");
  await assert.rejects(extractText(path.join(documents, "01_Product_Guide.pdf")), expectError("PDF_PASSWORD_REQUIRED", /password-protected.*unlocked PDF/));
  assert.equal(destroy.mock.callCount(), 1);
});

test("cleanup failures are reported without replacing a more useful OCR error", async (t) => {
  const originalDestroy = PDFParse.prototype.destroy;
  const failure = new Error("Resource cleanup failed");
  t.mock.method(PDFParse.prototype, "destroy", async function () {
    await originalDestroy.call(this);
    throw failure;
  });
  await assert.rejects(extractText(path.join(documents, "01_Product_Guide.pdf")), (error) => {
    expectError("PDF_PARSE_FAILED", /release PDF parser resources/)(error);
    assert.equal(error.cause, failure);
    return true;
  });
  const blank = await temporaryFile("cleanup-failure-blank.pdf", makePdf([""]));
  await assert.rejects(extractText(blank), expectError("OCR_REQUIRED", /OCR/));
});
