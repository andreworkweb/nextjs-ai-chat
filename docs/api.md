# API, streaming, and citations

[← README](../README.md) · [Architecture](architecture.md) · [Configuration](configuration.md)

## Routes

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `POST` | `/api/chat` | Validate a question, retrieve evidence, and stream an answer. |
| `GET` | `/api/documents/[documentId]` | Serve an allowlisted original public PDF inline. |
| `HEAD` | `/api/documents/[documentId]` | Perform the same document checks without a response body. |

There is no HTTP ingestion/upload endpoint. Indexing is a local [command-line operation](ingestion.md). No account authentication is implemented.

## Chat request

Send `Content-Type: application/json` and a JSON object:

```json
{
  "question": "What is the TaskFlow API rate limit? Cite the source."
}
```

[`chat-request.ts`](../src/lib/rag/chat-request.ts) trims leading/trailing whitespace and requires a string of 1–4000 characters under Zod's string-length validation. Internal whitespace, punctuation, URLs, and technical terms remain intact. The whole request body is capped at **512 KiB**, including streaming body reads even if `Content-Length` is missing or inaccurate. Invalid UTF-8/JSON is rejected.

The optional `history`, `messageId`, and `conversationId` fields use the existing [conversation validator](../app/lib/chat-context/context.ts). IDs use the allowed identifier format, and history must contain complete alternating user/assistant turns. Duplicate history IDs with conflicting contents are rejected. Invalid conversation metadata is returned as `400 INVALID_REQUEST` by the chat-query wrapper.

History is validated and available to the chat UI; the current RAG handler does not pass it to query embedding or answer generation. Client-supplied model IDs, credentials, system prompts, retrieval filters, and other unrelated fields are ignored.

### Try a streaming request

Run `npm run dev`, then in another terminal:

```bash
curl -N http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"question":"What is the TaskFlow API rate limit? Cite the source."}'
```

<details>
<summary>PowerShell 7 request</summary>

```powershell
$body = @{ question = "What is the TaskFlow API rate limit? Cite the source." } | ConvertTo-Json
Invoke-WebRequest http://localhost:3000/api/chat -Method Post `
  -ContentType application/json -Body $body -SkipHttpErrorCheck
```

`Invoke-WebRequest` collects the response for inspection. Use `curl.exe -N` with appropriate shell quoting when you want to observe incremental events on Windows. `-SkipHttpErrorCheck` requires PowerShell 7.

</details>

Successful grounded chat requires private OpenRouter/Qdrant settings and an ingested collection. Sending `{ "question": " " }` should return 400 with `code: "INVALID_REQUEST"` and a question validation detail, without invoking providers.

## Successful response and stream protocol

The successful response is **200** with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`, and `X-Accel-Buffering: no`.

The following are **wire-format illustrations**, not recorded model output. Each SSE event ends with a blank line:

```text
data: {"choices":[{"delta":{"content":"An answer fragment [S1]"}}]}

data: {"type":"citations","citations":[{"label":"[S1]","documentId":"<content-hash>","chunkId":"<chunk-id>","sourceName":"03_API_Guide.pdf","pageNumber":3}]}

data: [DONE]

```

The citation event is optional and is sent only when valid cited labels exist after successful generation. It precedes `[DONE]`. The insufficient-evidence path streams deterministic text and `[DONE]` without a model request or citation map.

The server waits for the first answer text before sending the response so early errors retain meaningful HTTP status codes. If a failure happens after streaming starts, the already-sent HTTP status stays 200 and the stream ends with a safe error event, **without `[DONE]`**:

```text
data: {"error":{"message":"The AI service could not complete the response. Please try again.","code":"AI_UPSTREAM_ERROR"}}

```

[`readChatStream`](../app/lib/read-chat-stream.ts) handles UTF-8 characters and events split across network chunks. Missing completion or a stream error marks the turn as failed/interrupted; the client does not save partial citations as a completed answer.

### Diagnostic headers

| Header | Meaning |
| :--- | :--- |
| `X-RAG-Query-Status` | `ready` after successful query embedding. |
| `X-RAG-Search-Status` | `ready` or `empty`. |
| `X-RAG-Retrieved-Chunks` | Pre-reranking hit count. |
| `X-RAG-Rerank-Status` | `ready` when genuine rerank scores exist; otherwise `original`. |
| `X-RAG-Selected-Chunks` | Post-reranking/fallback result count. |
| `X-RAG-Prompt-Status` | `ready` when at least one whole passage fits; otherwise `empty`. |
| `X-RAG-Prompt-Sources` | Number of included evidence labels, not the number ultimately cited. |
| `X-RAG-Answer-Status` | `grounded` or `insufficient-evidence`; `grounded` describes the path, not a factual correctness guarantee. |

These headers report pipeline state. Internal vectors, prompts, passage bodies, SDK reasoning, provider error bodies, and credentials are not serialized in this diagnostic metadata.

## HTTP errors

Early failures return JSON with `Cache-Control: no-store`:

```json
{
  "error": "The request must include a non-empty question of at most 4000 characters",
  "code": "INVALID_REQUEST",
  "details": [{ "field": "question", "message": "Question must not be empty" }]
}
```

| Status | Codes / causes |
| :--- | :--- |
| `400` | `INVALID_JSON`, `INVALID_REQUEST`, mandatory context `RAG_PROMPT_ERROR`, or provider context `AI_REQUEST_REJECTED`. |
| `413` | `REQUEST_TOO_LARGE` when the request body exceeds 512 KiB. |
| `415` | `UNSUPPORTED_MEDIA_TYPE` for a missing or non-JSON content type. |
| `429` | `AI_RATE_LIMITED` from answer generation. |
| `499` | `REQUEST_CANCELLED` when the client aborts and the handler can still return a response. |
| `500` | Sanitized `INTERNAL_ERROR` for an unexpected failure. |
| `502` | `AI_UPSTREAM_ERROR`, `AI_UNAVAILABLE`, or `AI_EMPTY_RESPONSE` from generation. |
| `503` | `AI_NOT_CONFIGURED`, embedding/database `RAG_UNAVAILABLE`, or invalid prompt configuration `RAG_PROMPT_ERROR`. |
| `504` | `AI_TIMEOUT` for a surfaced generation/overall timeout. |

Embedding errors, including exhausted embedding rate limits, are mapped to `503 RAG_UNAVAILABLE`; they are not exposed as generation's 429. Cancellation/deadline errors from an individual stage may be mapped through that stage's safe error handling. Next.js returns **405** for unsupported chat methods. Provider bodies and private exception messages are never included in the public error response.

## Citations and original PDFs

### Response-local source identity

The prompt builder assigns `[S1]` and subsequent labels to the exact included passages. Its private map contains real document IDs, source paths, original chunk IDs, indexes, and physical page numbers.

After the answer finishes, generation resolves exact markers in the answer against **that response's map**. It emits only cited, valid labels; repeats appear once and unknown labels receive no invented metadata. Display metadata includes a basename rather than a private path. This process adds no model calls, database searches, or PDF reads and does not delay the first token.

The UI renders a Sources list under the specific completed answer. React escapes names and text. A label can refer to a different document in a later answer because maps remain attached to their own messages. Valid citation metadata survives reloads; older answers without it are not retroactively given sources. Malformed optional metadata is discarded while keeping the saved answer.

This verifies **source identity**, not whether the model accurately interpreted the passage. A model may omit citations or misread the evidence.

### Allowlisted originals

[`documents.ts`](../src/lib/rag/documents.ts) explicitly allowlists the five TaskFlow PDFs already tracked under `public/documents/taskflow/`. The document API serves matching original bytes from `data/documents/taskflow/`; the two tracked copies match. Content IDs are the SHA-256 hashes used by ingestion.

Requests supply only a 64-character lowercase hexadecimal content ID. The resolver checks the allowlist/public flag, approved basename, canonical directory containment, regular-file status, size (5 bytes to 32 MiB), PDF header, and full content hash. Missing, inaccessible, changed, invalid, private, or unlisted files all return the same safe **404**. Marking an entry private currently denies access to everyone.

`GET` returns `application/pdf`, `Content-Disposition: inline`, the byte length, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: frame-ancestors 'self'`. `HEAD` runs the same checks, including reading/verifying the original bytes, without sending a response body.

Only already-public samples are accessible anonymously. Adding a file to ingestion does not add it to the download allowlist. Existing static `public/` copies remain public independently of the API; restricted files must never be placed there. Future restricted documents need server-side authorization shared by retrieval, GET, and HEAD.

### Link availability and page navigation

After completion or history restoration, the browser checks each distinct cited document in the background. A successful `HEAD` with `application/pdf` enables a link; a failed, forbidden, missing, or non-PDF response leaves plain source text. The check has a five-second deadline and is reused during the mounted chat session.

Links use `/api/documents/<content-id>#page=N`, open a new tab with `noopener noreferrer`, and depend on the browser PDF viewer for page navigation. GET validates access and bytes again because availability may change after HEAD. Reloading the chat rechecks availability.

Changing original PDF bytes requires deliberate allowlist/hash updates and re-ingestion; stale IDs never open a different version. [`next.config.ts`](../next.config.ts) includes the allowlisted originals in this route's server file trace for deployment. See [deployment](deployment.md) for the production checklist.
