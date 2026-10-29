# Document ingestion and storage

[← README](../README.md) · [Architecture](architecture.md) · [Configuration](configuration.md)

Run indexing from the project root with Node.js 24 and private provider/cloud configuration in `.env.local`:

```bash
npm run ingest
```

The package script expands to `node --env-file-if-exists=.env.local scripts/ingest.ts`. There are no documented CLI flags for changing the directory or providers. Programmatic callers can inject a directory, embedding function, connection, and progress callback through `ingestDocuments(options)`.

## Supported documents

| Format | Extraction behavior |
| :--- | :--- |
| `.pdf` | `pdf-parse` v2 extracts text from each physical page; source page numbers remain one-based. |
| `.txt` | Strict UTF-8 text; one logical page numbered 1. |
| `.md`, `.markdown` | Strict UTF-8 Markdown text; one logical page numbered 1. |

The scanner recursively visits `data/documents/`, uses sorted directory entries, and processes supported regular files sequentially. Unsupported regular files are reported as skipped. Directory/file symlinks are not followed.

Included examples are `sample.txt`, `sample.md`, and five PDFs under `taskflow/`: product guide, plans and billing, API guide, troubleshooting, and release notes. [Question fixtures](../tests/fixtures/rag/taskflow-questions.json) identify expected source pages for sample queries.

Empty files, invalid UTF-8, binary-looking text, corrupt PDFs, and password-protected PDFs fail with extraction errors. Image-only PDFs report `OCR_REQUIRED`; perform OCR externally and provide a text-bearing PDF. Mixed PDFs retain blank pages so subsequent physical page numbers remain accurate.

## Normalization and chunking

[`extractText`](../src/lib/rag/extract-text.ts) calls the shared normalizer and leaves source files unchanged. Normalization handles byte-order marks, line endings, control characters, redundant spacing, and excess blank lines while preserving paragraph structure, code fences, indentation, inline code, and Markdown hard breaks.

[`splitText`](../src/lib/rag/split-text.ts) processes each normalized page independently. The recursive splitter prefers paragraphs, lines, sentence boundaries, spaces, then characters. It keeps sentence punctuation and avoids splitting Unicode surrogate pairs. Blank pages produce no chunks.

Defaults are **1000 JavaScript string units** per chunk with a target **200-unit overlap**. These are character-oriented limits, not token limits; overlap can be smaller at natural boundaries. Use `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP`, or the helper's `chunkSize` / `chunkOverlap` options.

The default [Liquid embedding model](https://openrouter.ai/liquid/lfm-2.5-embedding-350m:free/providers) has a 512-token context limit. Dense multilingual input can exceed that limit even within the character bound. Reduce chunk size when necessary; embedding never silently truncates input. Keep overlap smaller than the new size.

## Source identity

Shared contracts live in [`types.ts`](../src/lib/rag/types.ts).

| Field | Meaning |
| :--- | :--- |
| `documentId` | SHA-256 of the original file bytes, independent of filename/location. |
| `sourceName` | Stable relative source path during ingestion, using `/` separators. |
| `pageNumber` | One-based physical PDF page, or 1 for a text file. |
| `chunkIndex` | Zero-based position within a page. |
| Chunk `id` | Deterministic UUID derived from document ID, page, index, and chunk text. |
| Qdrant point ID | Separate deterministic UUID scoped by relative source path and original chunk ID. |
| `ingestionRevision` | Hash of the source's sorted chunk IDs, used for revision cleanup. |

`generateEmbeddings(chunks)` retains each chunk field and adds `embedding: number[]`. Storage removes that vector from metadata and writes the remaining fields plus the revision into the payload. Identical files at different relative paths can coexist. Search returns the original chunk ID as `chunkId`; it does not confuse it with the scoped Qdrant point ID.

## Collection initialization

The scanner checks cloud access and collection compatibility before spending embedding requests. [`ensureQdrantCollection`](../src/lib/rag/qdrant.ts) creates a missing collection with one unnamed vector, the configured dimensions, and **Cosine** distance. It creates keyword indexes for `sourceName`, `documentId`, and `ingestionRevision`.

An existing collection with incompatible dimensions, distance, vector shape, or payload index types is rejected without deleting or recreating it. Set an explicit `QDRANT_COLLECTION`; there is no runtime fallback name. The template proposes `rag_documents`.

The SDK client initializes lazily and is reused within a backend process. Imports alone do not require cloud credentials, which allows build-time loading. The current connection validator accepts only HTTPS endpoints whose hostname ends in `.cloud.qdrant.io`, without embedded credentials, query, fragment, or path.

## Verified replacement of a source

[`storeEmbeddings`](../src/lib/rag/store-embeddings.ts) groups chunks by source and requires one document version with unique chunk IDs per group. Writes use batches of 64 by default; the helper accepts `batchSize` from 1 to 256.

For each source it:

1. Upserts deterministic points with `wait: true`.
2. Retrieves every new point with payload and vector.
3. Compares payloads and vector directions. Cosine collections normalize vectors on upload, so verification accounts for normalization with a tolerance of `0.0001`.
4. Deletes points for the same `sourceName` whose revision differs, only after all new points pass read-back verification.
5. Confirms that the final exact source count matches the new chunk count.

Repeated runs with unchanged content keep the same point identities. Edited content and changed chunk boundaries replace older revisions after successful verification.

> [!IMPORTANT]
> Run one ingestion writer at a time. Source replacement spans multiple requests and is not transactional. Failed writes retain old revisions but may leave partial new points alongside them; re-running repairs the source. Cleanup failures can also require a rerun.

Removing or renaming a file on disk does **not** remove its previous source path from Qdrant. Plan explicit cleanup for retired sources. Ingestion only cleans revisions of source paths successfully processed in the current run.

## Progress and failures

The command prints one JSON progress record per file with `sourceName`, `status`, `pages`, `chunks`, `verified`, and a safe error when needed. A final summary reports `processedFiles`, `skippedFiles`, `errors`, `chunks`, and `verified`. Any failed file produces a nonzero process exit code while other files can still complete.

Review errors and verified counts, then rerun ingestion after resolving failures. Do not infer whole-run success from one processed file. Changing the embedding model or dimensions requires a [consistent vector-space migration](configuration.md#changing-models-and-reindexing).

## Retrieval is separate from PDF publishing

Indexing makes text retrievable from the configured collection. It does not grant original-file download access. Only five explicitly allowlisted public sample PDFs are served by the document API; text and custom PDFs do not acquire links automatically.

Conversely, files under `public/` are already static public assets. Keep restricted documents outside that directory and add server-side authorization before enabling restricted retrieval or downloads. [Document access checks](api.md#citations-and-original-pdfs)

## Focused verification

```bash
node --test tests/extract-text.test.mjs tests/normalize-text.test.mjs tests/split-text.test.mjs
node --test tests/generate-embeddings.test.mjs tests/qdrant.test.mjs tests/store-embeddings.test.mjs tests/ingest.test.mjs
```

These tests use mock providers and an in-memory database double. Real ingestion writes to your configured cluster and uses provider quota. [Opt-in live checks](testing.md#opt-in-live-checks) cover cloud read-back and retrieval.
