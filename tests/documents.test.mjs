import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PUBLIC_DOCUMENTS, readPublicDocument } from "../src/lib/rag/documents.ts";
import { GET, HEAD } from "../app/api/documents/[documentId]/route.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "rag-pdf-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.join(path.resolve(tmpdir()), "rag-pdf-")));
    await rm(resolved, { recursive: true, force: true });
  });
  const bytes = Buffer.from("%PDF-1.7\nOriginal test bytes\n%%EOF");
  const entry = { documentId: hash(bytes), fileName: "Guide.pdf", access: "public" };
  await writeFile(path.join(directory, entry.fileName), bytes);
  return { directory, bytes, entry, documents: [entry] };
}
const context = (documentId) => ({ params: Promise.resolve({ documentId }) });
const request = (id, method = "GET") => new Request(`http://localhost/api/documents/${encodeURIComponent(id)}`, { method });

test("the explicit allowlist resolves exactly the original PDFs already published by the project", async () => {
  assert.equal(PUBLIC_DOCUMENTS.length, 5);
  for (const entry of PUBLIC_DOCUMENTS) {
    const document = await readPublicDocument(entry.documentId);
    assert.ok(document);
    const original = await readFile(new URL(`../data/documents/taskflow/${entry.fileName}`, import.meta.url));
    const published = await readFile(new URL(`../public/documents/taskflow/${entry.fileName}`, import.meta.url));
    assert.deepEqual(document.bytes, original);
    assert.deepEqual(document.bytes, published);
    assert.equal(hash(original), entry.documentId);
    assert.equal(entry.access, "public");
  }
});

test("only an exact validated allowlisted ID resolves; request paths are never accepted", async (t) => {
  const options = await fixture(t);
  assert.deepEqual((await readPublicDocument(options.entry.documentId, options)).bytes, options.bytes);
  for (const id of [undefined, null, 42, "", "../.env.local", "Guide.pdf", "%2e%2e%2f.env.local", "A:\\private\\Guide.pdf",
    options.entry.documentId.toUpperCase(), "0".repeat(64), `${options.entry.documentId}/../private.pdf`]) {
    assert.equal(await readPublicDocument(id, options), null);
  }
});

test("private and unlisted files remain unauthorized even when their bytes and IDs are known", async (t) => {
  const options = await fixture(t);
  assert.equal(await readPublicDocument(options.entry.documentId, { ...options, documents: [{ ...options.entry, access: "private" }] }), null);
  assert.equal(await readPublicDocument(options.entry.documentId, { ...options, documents: [] }), null);
});

test("missing, changed, invalid, and directory entries never resolve to a downloadable PDF", async (t) => {
  const options = await fixture(t);
  assert.equal(await readPublicDocument(options.entry.documentId, { ...options, documents: [{ ...options.entry, fileName: "Missing.pdf" }] }), null);
  for (const fileName of ["../Guide.pdf", "nested/Guide.pdf", ".env.local", 'Guide.pdf"\r\nX-Test: bad']) {
    assert.equal(await readPublicDocument(options.entry.documentId, { ...options, documents: [{ ...options.entry, fileName }] }), null);
  }
  await writeFile(path.join(options.directory, options.entry.fileName), "%PDF-1.7\nDifferent version");
  assert.equal(await readPublicDocument(options.entry.documentId, options), null);
  await mkdir(path.join(options.directory, "Directory.pdf"));
  assert.equal(await readPublicDocument(options.entry.documentId, { ...options, documents: [{ ...options.entry, fileName: "Directory.pdf" }] }), null);
  const text = Buffer.from("ordinary text, not a PDF");
  await writeFile(path.join(options.directory, "Text.pdf"), text);
  assert.equal(await readPublicDocument(hash(text), { ...options, documents: [{ ...options.entry, documentId: hash(text), fileName: "Text.pdf" }] }), null);
});

test("a symlink outside the approved directory is rejected", async (t) => {
  const options = await fixture(t);
  const inside = path.join(options.directory, "inside");
  await mkdir(inside);
  // Directory junctions work on Windows without requiring file-symlink privileges.
  await symlink(options.directory, path.join(inside, "Guide.pdf"), process.platform === "win32" ? "junction" : "dir");
  // The allowed basename is valid, but its canonical target escapes the root.
  assert.equal(await readPublicDocument(options.entry.documentId, { directory: inside, documents: options.documents }), null);
});

test("GET serves the original bytes inline with PDF headers and HEAD confirms availability", async () => {
  const entry = PUBLIC_DOCUMENTS[2];
  const response = await GET(request(entry.documentId), context(entry.documentId));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.equal(response.headers.get("Content-Disposition"), 'inline; filename="03_API_Guide.pdf"');
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), entry.documentId);
  assert.equal(response.headers.get("Content-Length"), String(bytes.length));
  const head = await HEAD(request(entry.documentId, "HEAD"), context(entry.documentId));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(bytes.length));
  assert.equal(await head.text(), "");
});

test("unknown and unauthorized document requests get indistinguishable safe errors", async () => {
  for (const id of ["0".repeat(64), "../.env.local", "sample.txt", "private-document"]) {
    const req = new Request("http://localhost/api/documents/unknown?path=.env.local&access=public", {
      headers: { Authorization: "Bearer browser-cannot-grant-access" },
    });
    const response = await GET(req, context(id));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Document not found or unavailable.");
    const head = await HEAD(request(id, "HEAD"), context(id));
    assert.equal(head.status, 404);
    assert.equal(await head.text(), "");
    assert.ok(![...response.headers].some(([, value]) => /data\/|\.env|browser-cannot/.test(value)));
  }
});
