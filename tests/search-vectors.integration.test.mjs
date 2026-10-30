import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { embedQuery } from "../src/lib/rag/embed-query.ts";
import { searchVectors } from "../src/lib/rag/search-vectors.ts";

const enabled = process.env.RUN_VECTOR_SEARCH_INTEGRATION === "1";
const configured = ["OPENROUTER_API_KEY", "QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION"]
  .every((name) => !!process.env[name]?.trim());

// Read-only: use the Step 1 questions and the existing Step 6 cloud index.
// No credentials, question text, or document passages are printed.
test("live query embeddings retrieve relevant indexed sample documents with citations", {
  skip: !enabled || !configured ? "Requires RUN_VECTOR_SEARCH_INTEGRATION=1, server credentials, and npm run ingest." : false,
  timeout: 180_000,
}, async (t) => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/rag/taskflow-questions.json", import.meta.url), "utf8"));
  const questions = [fixtures[5], fixtures[6]];
  for (const [index, fixture] of questions.entries()) {
    await t.test(`sample retrieval ${index + 1}`, { timeout: 75_000 }, async () => {
      const signal = AbortSignal.timeout(65_000);
      const vector = await embedQuery(fixture.question, { signal });
      const results = await searchVectors(vector, { limit: 10, minScore: -1, signal });
      assert.equal(results.length, 10, "The seven indexed samples provide more than ten chunks.");
      assert.ok(results.some((hit) => fixture.sources.some((source) => path.basename(hit.sourceName) === source.file && hit.page === source.page)),
        "At least one documented source page must appear in the top ten results.");
      for (const [position, hit] of results.entries()) {
        assert.ok(hit.text.trim() && hit.sourceName.trim() && hit.documentId.trim() && hit.chunkId.trim());
        assert.equal(hit.page, hit.pageNumber);
        assert.ok(Number.isSafeInteger(hit.page) && hit.page >= 1);
        assert.ok(Number.isFinite(hit.score));
        if (position) assert.ok(results[position - 1].score >= hit.score);
      }

      const first = results[0];
      const restricted = await searchVectors(vector, {
        limit: 2, minScore: -1,
        filter: { documentIds: [first.documentId], sourceNames: [first.sourceName] }, signal,
      });
      assert.ok(restricted.length > 0 && restricted.length <= 2);
      assert.ok(restricted.every((hit) => hit.documentId === first.documentId && hit.sourceName === first.sourceName));
      const threshold = Math.max(-1, Math.min(1, first.score - 0.000001));
      const relevant = await searchVectors(vector, { limit: 3, minScore: threshold, signal });
      assert.ok(relevant.length > 0 && relevant.every((hit) => hit.score >= threshold));
      assert.deepEqual(await searchVectors(vector, {
        filter: { documentIds: ["not-an-indexed-document-search-smoke-test"] }, signal,
      }), []);
      assert.deepEqual(await searchVectors(vector, { filter: { documentIds: [] }, signal }), []);
      t.diagnostic(`Sample ${index + 1}: verified ${results.length} ranked passages, expected source page, metadata restrictions, score threshold, and empty results.`);
    });
  }
});
