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
private environment configuration and uses the existing bounded conversation
context, output token limit, and cancellation handling. The chat interface shows
the streamed answer and saves completed turns. Step 8 adds query embedding
preparation before generation; document search remains a later stage.

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
$body = @{ question = "Hello!" } | ConvertTo-Json
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

Document retrieval remains a later stage. Ordinary chat requires a valid
`OPENROUTER_API_KEY`, while validation tests use mocked HTTP and fake credentials.

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
deadline covers both stages. No Qdrant search or storage runs in this endpoint.

Ordinary chat remains available if the embedding stage reports a provider or
configuration error after its shared retry policy. A successful chat response
includes `X-RAG-Query-Status: ready` when the vector was prepared, or `unavailable`
when chat continued without it. This status describes query embedding only;
answers are still ordinary chat until document retrieval is connected.

Run the mocked unit and backend integration tests with Node.js 24:

```powershell
node --test tests/embed-query.test.mjs tests/generate-embeddings.test.mjs tests/chat-api.test.mjs
```

To check the deployed backend locally, run `npm run dev` and send a valid
`POST /api/chat` request as shown above. With the existing server environment
configured, expect HTTP 200, a streamed answer, and the `ready` header. No new
environment variables or browser-accessible credentials are needed.
