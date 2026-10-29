# Environment configuration

[← README](../README.md) · [Architecture](architecture.md) · [Deployment](deployment.md)

The safe [`.env.example`](../.env.example) lists required values and commented optional defaults. Copy it only for a new setup; merge missing entries into an existing `.env.local` without replacing private values. Next.js loads `.env.local` for the application; `npm run ingest` explicitly loads it with Node's environment-file flag.

All settings below belong on the **server**. Keep `.env.local` out of version control and never prefix provider or database credentials with `NEXT_PUBLIC_`. Production configuration must be supplied separately through the hosting environment.

## Required services

| Variable | Default | Requirement |
| :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | None | A valid OpenRouter key used by both embeddings and answer generation. |
| `QDRANT_URL` | None | HTTPS cluster URL ending in `.cloud.qdrant.io`, optionally with its supplied port. No credentials, path, query, or fragment. |
| `QDRANT_API_KEY` | None | Write-capable cluster/collection access for ingestion; read access for application retrieval. |
| `QDRANT_COLLECTION` | None in code; `rag_documents` in template | Valid collection name, up to 255 characters using letters, digits, `_`, `-`, and `.`; first character cannot be `.`. |

The existing validator does not accept local Qdrant, arbitrary self-hosted endpoints, or an HTTP URL. The cloud client uses a 30000 ms network timeout and at most four connections. It creates a missing collection only during ingestion/initialization, not during ordinary search.

## Document chunking

| Variable | Default | Accepted value |
| :--- | :--- | :--- |
| `RAG_CHUNK_SIZE` | `1000` | Positive safe integer, measured using JavaScript string length. Use at least 2 for supplementary Unicode characters. |
| `RAG_CHUNK_OVERLAP` | `200` | Nonnegative safe integer strictly smaller than chunk size; target overlap. |

These affect ingestion, not existing vectors. Re-ingest after changing them. Character counts are not token counts; respect the embedding model's input limit.

## Embeddings

| Variable | Default | Accepted value / behavior |
| :--- | :--- | :--- |
| `RAG_EMBEDDING_MODEL` | `liquid/lfm-2.5-embedding-350m:free` | Nonempty OpenRouter embedding model ID without whitespace. |
| `RAG_EMBEDDING_DIMENSIONS` | `1024` | Integer `1–65536`; must match returned vectors and collection settings. |
| `RAG_EMBEDDING_BATCH_SIZE` | `16` | Integer `1–128`; batches run sequentially. |
| `RAG_EMBEDDING_TIMEOUT_MS` | `30000` | Integer `1–120000`; per-batch attempt timeout. |
| `RAG_EMBEDDING_MAX_RETRIES` | `3` | Integer `0–5`; retries after the initial attempt, per batch. |

The embedding transport is fixed to OpenRouter. `RAG_EMBEDDING_DIMENSIONS` validates vector lengths and configures storage; it does **not** send a dimensions override to the provider. Choose the actual output dimensions of the model. Query embedding uses exactly the same configuration as document embedding.

The default [Liquid model](https://openrouter.ai/liquid/lfm-2.5-embedding-350m:free/providers) produces 1024 dimensions and has a 512-token context limit. The helper preserves full inputs and does not silently truncate or choose another model. See [retry behavior](architecture.md#shared-embeddings).

## Retrieval and context

| Variable | Default | Accepted value / behavior |
| :--- | :--- | :--- |
| `RAG_SEARCH_LIMIT` | `10` | Integer `1–100`. |
| `RAG_SEARCH_MIN_SCORE` | Unset | Finite Cosine score from `-1` to `1`; leave absent for no threshold. An empty value is invalid. |
| `RAG_CONTEXT_TOKEN_BUDGET` | `8192` | Integer `1–131072`; conservative accounting for the complete input prompt. |

The prompt budget counts UTF-8 bytes and message framing rather than exact model tokens. It includes the complete question, instructions, source metadata, JSON, and whole passages. It is separate from the fixed 8192-token output cap. An overly small budget either omits evidence or rejects a question whose mandatory prompt cannot fit.

Helper options such as `limit`, `minScore`, and `tokenBudget` override environment defaults for trusted backend callers. Browser request fields do not control those options.

## Optional Cohere reranking

| Variable | Default | Accepted value / behavior |
| :--- | :--- | :--- |
| `RAG_RERANK_ENABLED` | `false` | Enabled when the trimmed value equals `true`, case-insensitively. |
| `COHERE_API_KEY` | None | Needed only when reranking is enabled. |
| `RAG_RERANK_MODEL` | `rerank-v5.0-fast` | Nonempty Cohere Rerank model ID without whitespace. |
| `RAG_RERANK_TOP_N` | `5` | Integer `1–100`; applied only after successful reranking. |
| `RAG_RERANK_TIMEOUT_MS` | `10000` | Integer `1–60000`; includes response body reading. |

Enable with private server settings:

```dotenv
RAG_RERANK_ENABLED=true
COHERE_API_KEY=your-cohere-api-key
```

The fixed endpoint is Cohere Rerank v2. Disabled, misconfigured, or unavailable reranking preserves **all** original search hits and their vector order. It does not silently truncate to `TOP_N` on fallback. Caller cancellation still stops the request. There is no dedicated live Cohere integration test; the enabled path is covered with mock HTTP.

## Answer generation

| Variable | Default | Accepted value / behavior |
| :--- | :--- | :--- |
| `LLM_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b:free` | Nonempty OpenRouter model ID, at most 256 characters, without whitespace/control characters. |
| `LLM_TIMEOUT_MS` | `180000` | Integer `1–300000`; the route also has a fixed `180000` ms overall deadline. |

Answer generation uses the installed AI SDK's OpenAI-compatible Chat Completions adapter, pointed at OpenRouter. A separate OpenAI API key or configurable provider base URL is not part of the current implementation. The adapter package name does not imply direct OpenAI service usage.

Model IDs above are code defaults, not guarantees of availability, account access, or price. Check the configured provider's model catalog if a model is rejected. Setting a longer generation timeout cannot extend the route's overall deadline or a hosting platform's duration limit.

## Changing models and reindexing

An answer-model change only affects generation. Confirm that its input context and output limits fit the application's budgets; no document reindex is needed solely for `LLM_MODEL`.

An embedding-model change changes the vector space, even when dimensions stay the same:

1. Choose an available OpenRouter embedding model and its actual output dimensions.
2. Set `RAG_EMBEDDING_MODEL`, `RAG_EMBEDDING_DIMENSIONS`, and an appropriate chunk size/overlap.
3. Prefer a **new `QDRANT_COLLECTION`** for the new vector space; retain the previous collection until verification completes.
4. Run `npm run ingest` against the new collection and review verified counts.
5. Configure the application with the same model, dimensions, and collection, then restart or redeploy it.
6. Verify retrieval before retiring the old collection through your cloud administration workflow.

Do not query vectors generated by one model with query embeddings from another. Never rely on ingestion to recreate an incompatible collection or clean renamed/deleted sources automatically.

## Data sent to services

| Service | Data sent by this implementation |
| :--- | :--- |
| OpenRouter embeddings | Complete document chunks at ingestion, and the current question at query time. |
| Qdrant Cloud | Stored vectors and passage/source metadata; query vectors and trusted metadata filters during retrieval. |
| Cohere, when enabled | The current question and retrieved passage texts. |
| OpenRouter answer model | System instructions, the current question, and selected evidence/source metadata. |
| Browser storage | Conversation text and verified display citations for the anonymous browser profile. |

Account/provider retention policies are separate from the code. Review them before indexing sensitive material. The default model's [provider page](https://openrouter.ai/liquid/lfm-2.5-embedding-350m:free/providers) describes its data-use terms.
