This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## RAG embedding generation

Call `generateEmbeddings(chunks)` from `src/lib/rag/generate-embeddings.ts` on the
Node.js server after extraction, normalization, and splitting. It returns
`EmbeddedChunk[]`: every original chunk field plus an `embedding: number[]`.
Document IDs, chunk IDs, source names, page numbers, and chunk indexes stay intact.

Use the existing `OPENROUTER_API_KEY` in `.env.local` or your deployment's private
environment settings. Keep this file out of version control and never prefix the
key with `NEXT_PUBLIC_`. The module reads the key only on the server and sends it
only to the fixed OpenRouter HTTPS endpoint; no OpenAI key is needed.

Optional server configuration (these values are the defaults):

```dotenv
RAG_EMBEDDING_MODEL=liquid/lfm-2.5-embedding-350m:free
RAG_EMBEDDING_DIMENSIONS=1024
RAG_EMBEDDING_BATCH_SIZE=16
RAG_EMBEDDING_TIMEOUT_MS=30000
RAG_EMBEDDING_MAX_RETRIES=3
```

The [Liquid model](https://openrouter.ai/liquid/lfm-2.5-embedding-350m:free/providers)
has a 512-token input limit. The chunker's character limit is not a token limit;
for dense multilingual text, configure smaller chunks if the provider rejects an
input. The embedding stage preserves full chunk text and never silently truncates
it or switches models. If you change the embedding model, configure its actual
vector dimensions as well.

Batches run sequentially. The retry budget applies to each batch, with at most
five retries. Rate limits, request timeouts, network failures, and temporary
server errors use exponential delays starting at 500 ms. `Retry-After` is honored;
if it exceeds the 30-second wait bound, the call fails safely for a later retry.
Permanent request/authentication errors and invalid vectors are not retried.
Provider bodies and raw transport errors are excluded from public errors.

Run isolated unit tests with Node.js 24; they use fake credentials and mock HTTP:

```powershell
node --test tests/generate-embeddings.test.mjs
```

The separate live test is skipped by default. It checks that the OpenRouter key
is valid before sending two short synthetic inputs, and skips if authentication
is rejected. Run it explicitly in PowerShell:

```powershell
$env:RUN_EMBEDDINGS_INTEGRATION = "1"
node --env-file=.env.local --test tests/generate-embeddings.integration.test.mjs
Remove-Item Env:RUN_EMBEDDINGS_INTEGRATION
```

API calls and retry waits can also be injected through the function's optional
`fetch`, `sleep`, and `signal` options. No vector database storage is performed.

## Qdrant Cloud storage and ingestion

Use a managed [Qdrant Cloud](https://cloud.qdrant.io/) free-tier cluster. Copy its
HTTPS cluster endpoint and cluster API key into the existing `.env.local`:

```dotenv
QDRANT_URL=https://your-cluster.your-region.cloud.qdrant.io:6333
QDRANT_API_KEY=your-private-cluster-key
QDRANT_COLLECTION=rag_documents
```

`.env.example` contains only these three Qdrant settings with placeholders.
Preserve existing entries in `.env.local`; do not overwrite the file with the
example. `.env.local` stays Git-ignored, while `.env.example` is safe to commit.
No Docker, local Qdrant process, or browser-accessible API key is required.

With Node.js 24 and dependencies installed, run from the project root:

```powershell
npm run ingest
```

The script loads `.env.local`, recursively processes PDF/TXT/Markdown files in
`data/documents/`, and executes the existing Extract → Normalize → Split → Embed
pipeline before storing remotely. The extractor already performs normalization.
Seven sample files are included, with the original Step 1 files preserved.
Unsupported file types are reported as skipped and directory symlinks are not
followed. JSON progress records show filenames, pages, chunks, verification
counts, and safe errors. Any failed file produces a nonzero exit code.

The collection is created when missing, using Cosine similarity and the existing
embedding vector dimensions (currently 1024). An incompatible existing
collection is rejected without deleting or recreating it. Keyword indexes are
created for the payload fields used by source filtering and revision cleanup.

Every point stores chunk text, original chunk ID, document ID, source name,
page number, chunk index, and any additional chunk metadata. Point IDs are
deterministic UUIDs scoped by relative source path and original chunk ID; this
lets identical files in different folders coexist. Original IDs remain intact
in the payload. Cosine vectors are compared after normalization when verifying
read-back, since [Qdrant normalizes them on upload](https://qdrant.tech/documentation/manage-data/collections/).

Run `npm run ingest` again to confirm the same verified chunk counts. A successful
file ingestion writes and retrieves all new points before deleting obsolete
revisions for that source. Editing file contents or changing chunk boundaries
therefore does not accumulate old chunks. Failed updates retain previous data;
re-running repairs a partially completed write. Run one ingestion writer at a
time because multi-request source updates are not transactions. Files removed
from disk or renamed are not automatically deleted from the cloud collection;
cleanup only targets the source paths successfully processed in the current run.

Unit tests use an in-memory SDK test double, without a local database service:

```powershell
node --test tests/qdrant.test.mjs tests/store-embeddings.test.mjs tests/ingest.test.mjs
```

After ingestion, verify real cloud read-back and a nearest-neighbor query:

```powershell
$env:RUN_QDRANT_INTEGRATION = "1"
node --env-file=.env.local --test tests/qdrant.integration.test.mjs
Remove-Item Env:RUN_QDRANT_INTEGRATION
```

### Vercel production configuration

In the Vercel project, open **Settings → Environment Variables** and add the same
`QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COLLECTION` for Production, and Preview
if needed. Choose the **Secret** type for the API key. Vercel's
[Config and Secret environment variable types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types)
keep secrets available to deployments without displaying their saved values.
Redeploy after saving environment changes.

Backend code in a Node.js route or Server Component can import
`getQdrantClient()` and `getQdrantConnection()` from `src/lib/rag/qdrant.ts`. The
client initializes lazily and is reused within each backend process; no cloud
credentials are needed merely to import the module during a build. Use a
collection-scoped read-only Qdrant key in production when only retrieval is
needed, and a write-capable key locally for ingestion. Do not use a
`NEXT_PUBLIC_` prefix or import the storage modules into Client Components.
The website reads the pre-indexed cloud collection after deployment; visitors do
not need to install software or run ingestion themselves. This step does not
change OpenRouter, embedding model settings, or the existing chat endpoint.

## RAG question API (Step 7)

`POST /api/chat` accepts a JSON object with a `question` string. Send
`Content-Type: application/json`. [Zod](https://zod.dev/basics) validates the
request and provides the inferred `ChatQueryRequest` TypeScript type in
`src/lib/rag/chat-request.ts`. Leading and trailing whitespace is trimmed;
questions must contain 1–4000 Unicode code points after trimming. Internal
whitespace, punctuation, numbers, URLs, and technical terms are preserved.
Optional `history`, `messageId`, and `conversationId` fields use the existing
conversation validation. Unrelated fields, including client-supplied provider
settings, are discarded.

The handler lives in `src/app/api/chat/route.ts`. Since this project uses a root
`app/` directory, `app/api/chat/route.ts` forwards to that handler. The existing
`cacheComponents: true` configuration requires Node.js; this installed Next.js
version rejects explicit route-level `runtime` exports with that setting.
The existing chat client also sends `question` while
preserving its conversation metadata and local history.

Valid requests return **200** with a streamed `text/event-stream` response from
the existing OpenRouter chat model. The server reads `OPENROUTER_API_KEY` from
private environment configuration and uses the bounded Step 11 document prompt,
existing output limit, and cancellation handling. The chat interface shows the
streamed answer and saves completed turns. Steps 8–12 embed the question, retrieve
chunks, optionally rerank, build an evidence prompt, and generate a grounded answer.
Stored conversation history remains validated and available in the UI; it is not
supplied as factual evidence to the model.

Error responses use JSON and `Cache-Control: no-store`; successful streams use
`no-store, no-transform`. Invalid JSON or questions
return **400**; bodies above 512 KiB return **413**, even without an accurate
`Content-Length`; missing or non-JSON content types return **415**. Validation
errors include `details` with field names and messages. Unexpected failures
return a sanitized **500** error, and cancelled requests return **499**.
Missing server credentials return **503**, provider rate limits return **429**,
provider or network failures return **502**, and generation timeouts return
**504**. Upstream error bodies and private exception messages are not exposed.
Next.js returns **405** for unsupported methods.

To verify, run `npm run dev`, then in another PowerShell terminal:

```powershell
$body = @{ question = "What is the TaskFlow API rate limit?" } | ConvertTo-Json
Invoke-WebRequest http://localhost:3000/api/chat -Method Post `
  -ContentType application/json -Body $body -SkipHttpErrorCheck
```

Expect status 200 and a stream of answer events. Sending `{ "question": " " }` should
return 400 with `code: "INVALID_REQUEST"` and a question validation detail.
`-SkipHttpErrorCheck` requires PowerShell 7.

Run API validation, provider-error, and client streaming tests with Node.js 24:

```powershell
node --test tests/chat-api.test.mjs tests/use-chat.test.mjs
```

Grounded chat requires the server's `OPENROUTER_API_KEY`, Qdrant configuration,
and an ingested collection. Validation tests use mocked HTTP and fake credentials.

## Query embedding generation (Step 8)

Call `embedQuery(question, options?)` from `src/lib/rag/embed-query.ts` on the
Node.js backend. It returns one validated `number[]` that can be passed directly
to the next Qdrant retrieval stage. Empty and non-string questions are rejected.
The helper embeds the complete question once, preserving its text without
splitting or truncation. The provider's input token limit still applies.

Both `generateEmbeddings(chunks)` and `embedQuery(question)` use `embedTexts`
from the existing Step 5 module. There is one model, credential, and dimensions
configuration: the existing `OPENROUTER_API_KEY` and `RAG_EMBEDDING_*` variables.
The defaults remain `liquid/lfm-2.5-embedding-350m:free` with 1024 dimensions.
Timeouts, bounded exponential retries, rate-limit handling, finite-number
validation, and safe `EmbeddingGenerationError` errors are shared. The same
optional `fetch`, `sleep`, and `signal` transports support isolated tests.
Keep the shared configuration consistent with ingestion; if it changes, reindex
documents before comparing their vectors with query embeddings.

The chat route now validates the request, embeds only the current question, and
then streams the existing chat response. The vector stays on the server; it is
not included in the response, logs, or chat model prompt. Request cancellation
stops embedding and prevents chat generation. The existing overall request
deadline covers the pipeline stages. Step 9 now uses the vector for read-only
Qdrant search, described below.

If embedding fails after its shared retry policy, Step 12 returns a safe
`503 RAG_UNAVAILABLE` response. It does not generate an answer without retrieval.
Successful streams include `X-RAG-Query-Status: ready`. This status describes
embedding; `X-RAG-Answer-Status` describes generation or insufficient evidence.

Run the mocked unit and backend integration tests with Node.js 24:

```powershell
node --test tests/embed-query.test.mjs tests/generate-embeddings.test.mjs tests/chat-api.test.mjs
```

To check the deployed backend locally, run `npm run dev` and send a valid
`POST /api/chat` request as shown above. With the existing server environment
configured, expect HTTP 200, a streamed answer, and the `ready` header. No new
environment variables or browser-accessible credentials are needed.

## Semantic vector search (Step 9)

`searchVectors(queryEmbedding, options?)` in `src/lib/rag/search-vectors.ts`
uses the existing Step 6 cloud client and Qdrant's current
[`query()` API](https://api.qdrant.tech/api-reference/search/query-points).
It searches the existing collection without creating collections or writing data.
Only the required source payload fields are requested, with stored vectors omitted.

The default result limit is 10. Set server-side `RAG_SEARCH_LIMIT` or pass
`limit` to select 1–100 results. An optional `minScore` or server-side
`RAG_SEARCH_MIN_SCORE` sets the minimum Cosine similarity from -1 to 1.
There is no threshold by default, and explicit options override environment
defaults. Scores are returned in descending order.

Each strongly typed `VectorSearchResult` contains `text`, `sourceName`,
`documentId`, original `chunkId`, `chunkIndex`, `score`, and the one-based physical
`page`. The same page is retained as `pageNumber` for compatibility with
`ParsedPage`. The original chunk ID comes from payload `id`, rather than the
separate Qdrant point ID scoped by source name.

Use metadata restrictions from trusted backend code:

```typescript
const vector = await embedQuery(question);
const chunks = await searchVectors(vector, {
  limit: 10,
  filter: { documentIds: authorizedDocumentIds, sourceNames: selectedSourceNames },
});
```

`documentIds` and `sourceNames` are exact-match allowlists combined with AND;
within each list, any value can match. An empty list returns `[]` without a
database request. The filter uses Qdrant
[`match.any` conditions](https://qdrant.tech/documentation/search/filtering/)
on the payload indexes already created during ingestion. Invalid filter fields
are rejected, and returned passages outside the requested scope are rejected.
These filters support access restrictions; authentication and authorization must
derive the allowed scope on the server. Browser-supplied filter fields are not
forwarded by `/api/chat`. The current portfolio sample collection is public.

An empty collection, unmatched filter, or unmatched score threshold returns `[]`.
Missing collections, database failures, invalid vectors, and malformed source
metadata produce safe `QdrantStorageError` errors. Search validates finite,
non-zero vectors against the existing ingestion dimensions. Cancellation stops
awaiting search promptly; the SDK retains its existing bounded network timeout.

The backend pipeline now runs validation → query embedding → vector search →
optional reranking → prompt preparation → grounded answer generation. Retrieved
evidence is sent to the configured model; internal prompts are not sent to the browser.
`X-RAG-Search-Status` is `ready` or `empty`, and `X-RAG-Retrieved-Chunks` reports
the count. Embedding/database failures return `503 RAG_UNAVAILABLE`; successful
empty searches produce an insufficient-evidence answer without an LLM request.

Run isolated tests, including indexing and searching the Step 1 sample PDF:

```powershell
node --test tests/search-vectors.test.mjs tests/chat-api.test.mjs
```

After `npm run ingest`, run the separate read-only cloud integration test:

```powershell
$env:RUN_VECTOR_SEARCH_INTEGRATION = "1"
node --env-file=.env.local --test tests/search-vectors.integration.test.mjs
Remove-Item Env:RUN_VECTOR_SEARCH_INTEGRATION
```

The live test embeds two Step 1 fixture questions, checks expected source pages
among the top 10 hits, verifies filters and thresholds, and checks empty results.
It neither updates the index nor generates answers.

## Optional Cohere reranking (Step 10)

`rerankChunks(question, retrievedChunks, options?)` in
`src/lib/rag/rerank-chunks.ts` calls the real
[Cohere Rerank v2 API](https://docs.cohere.com/reference/rerank) when enabled.
The configurable default is Cohere's
[`rerank-v5.0-fast` model](https://docs.cohere.com/docs/models).
It compares the original question with the retrieved passage texts, maps returned
indexes back to the original chunks, sorts by the model's relevance scores, and
keeps the top five by default. Ties retain vector-search order.

Reranking is disabled by default. Existing `.env.local` entries are preserved;
the local file has an empty `COHERE_API_KEY` placeholder and
`RAG_RERANK_ENABLED=false`. No Cohere key is required for ordinary retrieval or
chat. Configure these private server variables locally or in Vercel when ready:

```dotenv
RAG_RERANK_ENABLED=false
COHERE_API_KEY=
RAG_RERANK_MODEL=rerank-v5.0-fast
RAG_RERANK_TOP_N=5
RAG_RERANK_TIMEOUT_MS=10000
```

To enable later, set `RAG_RERANK_ENABLED=true` and provide a valid
`COHERE_API_KEY`. Keep the key out of Git, browser code, and `NEXT_PUBLIC_`
variables; use a secret environment variable in Vercel and redeploy after saving
production configuration. The fixed HTTPS endpoint receives the key only in its
authorization header. The browser cannot enable reranking or supply its settings.

Successful results add a genuine `rerankScore` between 0 and 1. The original
vector `score`, complete text, document/chunk IDs, source name, physical page,
and extra metadata remain intact. The `RerankedChunk` contract extends
`VectorSearchResult`, with `rerankScore` optional for fallback results. Inputs
and their order are never mutated.

Disabled or unavailable reranking returns **all** original vector-search hits
in their existing order, without truncating to five or adding scores. Missing
credentials, invalid optional configuration, authentication errors, rate limits,
network failures, timeouts, and invalid/incomplete model responses all fall back.
One bounded request is attempted, without retry delays on this optional stage.
The default timeout is 10 seconds and includes reading the response body.
Caller cancellation propagates so the backend stops before chat generation.
Provider response bodies, private exceptions, questions, and document passages
are not logged.

The backend calls reranking after successful vector search. Results stay on the
server for Step 11 prompt construction. `X-RAG-Rerank-Status` is `ready` when real
model scores were applied, or `original` when vector-search order was retained.
`X-RAG-Selected-Chunks` reports the post-reranking count, while
`X-RAG-Retrieved-Chunks` retains the pre-reranking count.

Run the mocked unit and backend integration tests without a Cohere key:

```powershell
node --test tests/rerank-chunks.test.mjs tests/chat-api.test.mjs
```

The enabled-model path, metadata preservation, sorting, disabled behavior,
fallbacks, and cancellation are covered with mock HTTP responses. No live Cohere
call was made for Step 10; live model validation is deferred until a key is configured.

## Context-aware prompt construction (Step 11)

Call `buildPrompt(question, retrievedChunks, options?)` from
`src/lib/rag/build-prompt.ts` on the server. It accepts vector-search results or
complete reranked results and returns a typed `BuiltPrompt` with `messages`,
`sources`, `estimatedTokens`, `tokenBudget`, and included/omitted chunk counts.
It performs no network requests and does not call an LLM.

The messages contain system instructions and a JSON user message containing the
complete question and document evidence. Each included passage receives a unique
label such as `[S1]`. `sources["[S1]"]` maps to the real `documentId`, `sourceName`,
`chunkId`, `chunkIndex`, and one-based `pageNumber`/`page`. Original passage text
and source identity are preserved. Labels are local to each constructed prompt.

Instructions require answers supported only by the supplied evidence, citations
using supplied labels, and an explicit admission when evidence is insufficient.
Document text and filenames are untrusted JSON data, never system instructions.
This separation and the instructions reduce prompt injection risk; they do not
guarantee how a model will behave. Empty retrieval produces an empty
source map and an instruction to acknowledge insufficient evidence.

The configurable budget covers **all** messages: instructions, complete question,
JSON structure, source metadata, evidence, and message framing. Set private
`RAG_CONTEXT_TOKEN_BUDGET` locally or in Vercel (default `8192`), or pass
`{ tokenBudget: 4096 }` on the server. Valid budgets are integers from 1 to 131072.
The builder reuses the existing conservative UTF-8 byte estimate plus framing;
this is a bounded estimate, not an exact model-specific tokenizer count.

Chunks are prioritized by Cohere score when all results have one, otherwise by
vector similarity; ties preserve retrieval order. Whole chunks are included only
when they fit. Oversized passages are skipped so smaller passages can still fit,
without truncating technical facts or the question. Only included evidence gets
a citation mapping. Mixed reranked/vector-only result sets are rejected.
Invalid inputs/configuration produce typed `PromptConstructionError` errors.
If mandatory instructions and the complete question exceed the budget,
`BUDGET_EXCEEDED` is raised.

The backend prepares this prompt after optional reranking and passes it to Step 12.
`X-RAG-Prompt-Status` reports `ready` or `empty`; `X-RAG-Prompt-Sources` reports
the included citation count. Invalid configuration stops generation with a safe
error; mandatory context exceeding the budget returns 400. No new credentials
are needed for prompt construction.

Verify formatting, source mapping, budgets, hostile document data, sample PDF
pages, and backend preparation with mocked providers:

```powershell
node --test tests/build-prompt.test.mjs tests/chat-api.test.mjs
```

## Grounded streamed answers (Step 12)

`generateAnswer(builtPrompt, options?)` in `src/lib/rag/generate-answer.ts` uses
the installed Vercel AI SDK 7 `streamText`, `instructions`, and `result.stream`
APIs. The `@ai-sdk/openai` Chat Completions adapter connects to the project's
existing fixed OpenRouter HTTPS endpoint. It does not use the OpenAI Responses
API, AI Gateway, or a different provider credential. Embedding settings are unchanged.

Private configuration in `.env.local` or Vercel:

```dotenv
# Reuse the existing OPENROUTER_API_KEY; do not replace or commit it.
LLM_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
LLM_TIMEOUT_MS=180000
```

`LLM_MODEL` defaults to the project's existing model above if absent. Model
availability depends on OpenRouter; set another supported OpenRouter model ID
on the server when needed. The timeout defaults to 180000 ms and accepts integers
from 1 to 300000; the entire chat request also has its existing 180000 ms deadline.
Set these in Vercel's server environment and redeploy. Never use `NEXT_PUBLIC_`
for credentials. Browser-supplied model, system prompt, or API key fields are ignored.

The helper returns `{ stream, sources, status }`. `sources` is a snapshot of the
Step 11 citation map retained server-side for Step 13 source verification.
`stream` uses the existing SSE content-delta and `[DONE]`
format, so the current chat interface and saved conversation UI continue to work.
Generated answer text and the verified Step 13 citation metadata are serialized;
SDK reasoning, raw errors, provider metadata, prompts, and credentials are not
forwarded or logged.

If retrieval is empty, relevance filtering removes all hits, or no complete
passage fits the prompt budget, a deterministic message states that the supplied
documents do not provide enough information. No model call is made in that case;
`X-RAG-Answer-Status` is `insufficient-evidence`. Otherwise it is `grounded` and
the system instructions require context-only answers, valid citation labels,
and admitting uncertainty when the passages do not support the question. The
existing optional `RAG_SEARCH_MIN_SCORE` can exclude weak vector matches; a
nonempty result alone is not proof that it answers the question.

Retrieval failures produce `503 RAG_UNAVAILABLE`, rather than a general-knowledge
fallback. Early generation errors return sanitized HTTP errors: 429 for rate
limits, 400 for rejected context, 502 for provider/network/empty responses, 503
for missing configuration, 504 for timeout, and 499 for client cancellation.
The server waits only for the first answer text before returning the response.
Errors after streaming starts use a sanitized SSE error without `[DONE]`, so
the client marks the partial turn as interrupted. Cancellation aborts the model
request; automatic generation retries are disabled to avoid duplicate output.

Run mocked SDK transport, backend pipeline, and browser streaming tests:

```powershell
node --test tests/generate-answer.test.mjs tests/chat-api.test.mjs tests/use-chat.test.mjs
```

Optional live checks are skipped by default. They send synthetic evidence to
the configured model; when Qdrant configuration is present, they also run a
read-only complete query against the pre-indexed sample documents. They may
consume provider quota and require a working model/key and an ingested collection:

```powershell
$env:RUN_ANSWER_INTEGRATION = "1"
node --env-file=.env.local --test tests/generate-answer.integration.test.mjs
Remove-Item Env:RUN_ANSWER_INTEGRATION
```

Production compilation was verified with `npm run build -- --webpack`. The
default Turbopack build encountered a CSS worker startup crash in this Windows
environment; the existing bundler configuration has not been changed by Step 12.

## Verified citations in the existing chat (Step 13)

The prompt builder assigns labels such as `[S5]` to the exact retrieved chunks
included in the model context. After a successful answer finishes, generation
matches its markers against that response's existing `sources` map. A `citations`
SSE event is emitted immediately before the existing `[DONE]` marker. It contains
only cited, valid labels with their real document ID, chunk ID, display filename,
and one-based page number. Repeated labels are listed once; unknown labels never
receive invented metadata. This verifies source identity, not the factual
correctness of a model's interpretation.

No model calls, database searches, or document reads are added for citations.
Text deltas are delivered as before; source selection and serialization happen
after the last answer text, so citation work does not delay the first token.
Private path prefixes are removed for display. Citations are plain text, with
no generated document URLs or public links to private files.

The existing stream reader collects the optional metadata event, and `useChat`
stores the verified citations on that specific completed assistant message.
The existing chat component renders a small Sources list beneath that answer,
for example `[S5] 03_API_Guide.pdf · Page 3`, using the existing styling. All
filenames and answer text are escaped by React. Each answer retains its own map,
so `[S1]` in two different turns can refer to different documents safely.

Saved conversations retain citations across reloads under the existing storage
schema. Older messages without metadata continue to render normally; their raw
markers are not reconstructed into sources. Malformed optional citation data is
discarded without losing the saved answer. Source metadata is not sent back as
conversation context. Interrupted responses never commit partial citations;
retry, reset, cancellation, and cross-tab behavior remain in the existing flow.

Run mapping, UTF-8/SSE compatibility, rendering, persistence, and backend tests:

```powershell
node --test tests/citations.test.mjs tests/chat-ui.test.mjs tests/chat-storage.test.mjs tests/use-chat.test.mjs tests/generate-answer.test.mjs tests/chat-api.test.mjs
```

For a manual check, run `npm run dev` and ask about TaskFlow's API rate limit.
After streaming completes, valid markers should have a Sources list showing
the actual document name and page. Reload and send another question to verify
that earlier source lists remain attached to their original answers.
