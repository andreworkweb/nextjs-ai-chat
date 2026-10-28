import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEmbeddings } from "../src/lib/rag/generate-embeddings.ts";
import { splitText } from "../src/lib/rag/split-text.ts";

const enabled = process.env.RUN_EMBEDDINGS_INTEGRATION === "1";
const key = process.env.OPENROUTER_API_KEY?.trim();

// This provider-specific integration uses an OpenRouter key, not an OpenAI key.
// Only synthetic text is sent. Credentials and response bodies are never printed.
test("live Liquid/OpenRouter embedding generation retains chunk metadata", {
  skip: !enabled || !key ? "Requires RUN_EMBEDDINGS_INTEGRATION=1 and a valid OPENROUTER_API_KEY." : false,
  timeout: 90_000,
}, async (t) => {
  let authentication;
  try {
    authentication = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000), cache: "no-store", redirect: "error",
    });
  } catch {
    throw new Error("Unable to verify the live OpenRouter key. Check network access.");
  }
  await authentication.body?.cancel().catch(() => {});
  if (authentication.status === 401 || authentication.status === 403) {
    t.skip("The configured OpenRouter key is invalid or is not authorized.");
    return;
  }
  assert.ok(authentication.ok, `OpenRouter key verification failed (HTTP ${authentication.status}).`);

  // Bound this smoke test independently of production request/retry settings.
  process.env.RAG_EMBEDDING_MAX_RETRIES = "1";
  process.env.RAG_EMBEDDING_TIMEOUT_MS = "20000";
  const chunks = await splitText([
    { documentId: "embedding-smoke-document", sourceName: "synthetic-smoke.txt", pageNumber: 1, text: "TaskFlow supports CSV export." },
    { documentId: "embedding-smoke-document", sourceName: "synthetic-smoke.txt", pageNumber: 2, text: "Projects contain tasks and due dates." },
  ]);
  const results = await generateEmbeddings(chunks);
  const dimensions = Number(process.env.RAG_EMBEDDING_DIMENSIONS ?? 1024);
  assert.equal(results.length, chunks.length);
  for (const [index, result] of results.entries()) {
    const { embedding, ...metadata } = result;
    assert.equal(embedding.length, dimensions);
    assert.ok(embedding.every((value) => typeof value === "number" && Number.isFinite(value)));
    assert.deepEqual(metadata, chunks[index]);
  }
});
