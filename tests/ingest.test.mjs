import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ingestDocuments } from "../scripts/ingest.ts";
import { storeEmbeddings } from "../src/lib/rag/store-embeddings.ts";
import { embeddedChunk, fakeQdrant } from "./helpers/fake-qdrant.mjs";

let directory;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "rag-ingest-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const embed = async (chunks) => chunks.map((chunk) => ({ ...chunk, embedding: [1, 0.5, 0.25] }));

test("ingestion extracts, normalizes, splits, embeds, stores, and verifies relative source paths", async () => {
  await mkdir(path.join(directory, "nested"));
  await writeFile(path.join(directory, "guide.txt"), "First   paragraph.\r\n\r\n\r\nSecond   paragraph.");
  await writeFile(path.join(directory, "nested", "guide.md"), "#   A nested guide\n\nMore   text.");
  await writeFile(path.join(directory, "ignored.png"), "unsupported");
  const fake = fakeQdrant();
  const progress = [];
  const report = await ingestDocuments({ directory, connection: fake.connection, embed, onProgress: (file) => progress.push(file) });
  assert.equal(report.processedFiles, 2);
  assert.equal(report.skippedFiles, 1);
  assert.equal(report.errors, 0);
  assert.equal(report.chunks, 2);
  assert.equal(report.verified, 2);
  assert.equal(progress.length, 3);
  assert.deepEqual([...fake.points.values()].map((point) => point.payload.sourceName).sort(), ["guide.txt", "nested/guide.md"]);
  assert.equal([...fake.points.values()].find((point) => point.payload.sourceName === "guide.txt").payload.text, "First paragraph.\n\nSecond paragraph.");
});

test("repeated runs and file edits leave exactly the latest chunks per stable source", async () => {
  const file = path.join(directory, "guide.txt");
  await writeFile(file, "Original guide.");
  const fake = fakeQdrant();
  const options = { directory, connection: fake.connection, embed };
  await ingestDocuments(options);
  const initial = [...fake.points.keys()];
  await ingestDocuments(options);
  assert.deepEqual([...fake.points.keys()], initial);
  await writeFile(file, "Updated passage. ".repeat(180));
  const updated = await ingestDocuments(options);
  assert.equal(fake.points.size, updated.chunks);
  assert.ok(initial.every((id) => !fake.points.has(id)));
  assert.ok(updated.chunks > 1);
  await writeFile(file, "Short final guide.");
  const shortened = await ingestDocuments(options);
  assert.equal(shortened.chunks, 1);
  assert.equal(fake.points.size, 1);
});

test("failed documents retain previous vectors while successful files still process", async () => {
  await writeFile(path.join(directory, "bad.txt"), "");
  await writeFile(path.join(directory, "good.md"), "# Valid document");
  const fake = fakeQdrant();
  await storeEmbeddings([embeddedChunk(0, { sourceName: "bad.txt" })], { connection: fake.connection });
  const report = await ingestDocuments({ directory, connection: fake.connection, embed });
  assert.equal(report.errors, 1);
  assert.equal(report.processedFiles, 1);
  assert.equal(report.files.find((file) => file.sourceName === "bad.txt").status, "failed");
  assert.ok([...fake.points.values()].some((point) => point.payload.sourceName === "bad.txt"));
  assert.ok([...fake.points.values()].some((point) => point.payload.sourceName === "good.md"));
});

test("cloud failures are checked before embedding and cannot leak raw errors", async () => {
  await writeFile(path.join(directory, "guide.txt"), "A guide.");
  const fake = fakeQdrant();
  fake.client.getCollection = async () => { throw Object.assign(new Error("secret-key private transport body"), { status: 403 }); };
  let embeddingCalls = 0;
  await assert.rejects(ingestDocuments({ directory, connection: fake.connection, embed: async () => { embeddingCalls++; return []; } }), (error) => {
    assert.equal(error.code, "CONNECTION_ERROR");
    assert.ok(!error.message.includes("secret-key"));
    return true;
  });
  assert.equal(embeddingCalls, 0);
});

test("unexpected pipeline errors are summarized without logging content or secrets", async () => {
  await writeFile(path.join(directory, "guide.txt"), "private document contents");
  const fake = fakeQdrant();
  const report = await ingestDocuments({ directory, connection: fake.connection, embed: async () => { throw new Error("secret-key private document contents"); } });
  assert.equal(report.errors, 1);
  assert.equal(report.processedFiles, 0);
  assert.ok(!JSON.stringify(report).includes("secret-key"));
  assert.ok(!JSON.stringify(report).includes("private document contents"));
});

test("missing and empty document directories return meaningful errors", async () => {
  const fake = fakeQdrant();
  await assert.rejects(ingestDocuments({ directory: path.join(directory, "missing"), connection: fake.connection, embed }), /must exist and be readable/);
  await assert.rejects(ingestDocuments({ directory, connection: fake.connection, embed }), /No PDF, TXT, or Markdown/);
});

test("the ingestion CLI exits unsuccessfully with a safe missing-configuration message", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, ["scripts/ingest.ts"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, QDRANT_URL: "", QDRANT_API_KEY: "", QDRANT_COLLECTION: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QDRANT_URL is required/);
  assert.ok(!result.stderr.includes("Bearer"));
});
