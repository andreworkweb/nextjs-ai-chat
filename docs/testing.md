# Testing and verification

[← README](../README.md) · [API](api.md) · [Deployment](deployment.md)

Use **Node.js 24** and run commands from the project root after `npm ci`. The repository uses Node's native test runner and TypeScript support; there is no `test` or `typecheck` package script.

## Default checks

```bash
npm run lint
npx --no-install tsc --noEmit
node --test tests/*.test.mjs
```

The default suite uses fake credentials, mock HTTP, temporary files, and an in-memory Qdrant SDK double. Do not load `.env.local` for ordinary unit tests. The four integration files contain five opt-in live tests that skip by default. Make sure the `RUN_*_INTEGRATION` flags below are unset for an offline run.

The document resolver suite creates a temporary directory symlink to verify containment. Windows may need Developer Mode or permission to create symbolic links. An `EPERM` during test fixture creation can be an environment restriction rather than a failed document-access assertion.

## Focused checks

| Area | Test files under `tests/` |
| :--- | :--- |
| Document preparation | `extract-text.test.mjs`, `normalize-text.test.mjs`, `split-text.test.mjs` |
| Embedding and storage | `generate-embeddings.test.mjs`, `qdrant.test.mjs`, `store-embeddings.test.mjs`, `ingest.test.mjs` |
| Retrieval and context | `embed-query.test.mjs`, `search-vectors.test.mjs`, `rerank-chunks.test.mjs`, `build-prompt.test.mjs` |
| Generation and HTTP | `generate-answer.test.mjs`, `chat-api.test.mjs` |
| Chat and sources | `chat-context.test.mjs`, `chat-storage.test.mjs`, `use-chat.test.mjs`, `chat-ui.test.mjs`, `citations.test.mjs`, `documents.test.mjs` |

For example:

```bash
node --test tests/search-vectors.test.mjs tests/rerank-chunks.test.mjs tests/build-prompt.test.mjs
node --test tests/generate-answer.test.mjs tests/chat-api.test.mjs tests/use-chat.test.mjs
node --test tests/documents.test.mjs tests/citations.test.mjs tests/chat-ui.test.mjs tests/chat-storage.test.mjs
```

Coverage includes retries, metadata preservation, idempotent source updates, filters, fallback behavior, conservative prompt budgets, untrusted evidence, stream framing, citation persistence, cancellation, and cross-tab coordination. UI tests render the real chat component with controlled state, and hook tests use a lightweight scheduler; they are not full browser end-to-end tests.

## Opt-in live checks

Live checks require reachable services, valid private credentials, and appropriate account/model access. They can consume provider quota. The vector-search and full-answer checks depend on the included sample documents having been indexed with `npm run ingest`.

| Flag | Test file | External work |
| :--- | :--- | :--- |
| `RUN_EMBEDDINGS_INTEGRATION=1` | `generate-embeddings.integration.test.mjs` | Verifies OpenRouter authentication, then embeds short synthetic inputs; rejected authentication is skipped. |
| `RUN_QDRANT_INTEGRATION=1` | `qdrant.integration.test.mjs` | Ensures compatible collection/index configuration, checks stored points, read-back, and similarity search. May create missing collection/indexes; run after ingestion. |
| `RUN_VECTOR_SEARCH_INTEGRATION=1` | `search-vectors.integration.test.mjs` | Embeds two fixture questions and checks expected source pages, filters, thresholds, and empty matches; no index writes or answer generation. |
| `RUN_ANSWER_INTEGRATION=1` | `generate-answer.integration.test.mjs` | Streams an answer from synthetic evidence and, when Qdrant is configured, runs a complete read-only sample retrieval/answer query. |

There is no separate live Cohere test. Mock HTTP covers enabled reranking, score mapping, sorting, failures, and cancellation. If testing optional reranking manually, confirm `X-RAG-Rerank-Status: ready`; a successful request can otherwise be a fallback.

### POSIX shell

Each flag is scoped to its command:

```bash
RUN_EMBEDDINGS_INTEGRATION=1 node --env-file=.env.local --test tests/generate-embeddings.integration.test.mjs
RUN_QDRANT_INTEGRATION=1 node --env-file=.env.local --test tests/qdrant.integration.test.mjs
RUN_VECTOR_SEARCH_INTEGRATION=1 node --env-file=.env.local --test tests/search-vectors.integration.test.mjs
RUN_ANSWER_INTEGRATION=1 node --env-file=.env.local --test tests/generate-answer.integration.test.mjs
```

### PowerShell

Use the flag matching the test you intend to run; remove it afterward:

```powershell
$env:RUN_EMBEDDINGS_INTEGRATION = "1"
try {
  node --env-file=.env.local --test tests/generate-embeddings.integration.test.mjs
} finally {
  Remove-Item Env:RUN_EMBEDDINGS_INTEGRATION
}
```

<details>
<summary>Qdrant, retrieval, and answer checks in PowerShell</summary>

```powershell
$env:RUN_QDRANT_INTEGRATION = "1"
try {
  node --env-file=.env.local --test tests/qdrant.integration.test.mjs
} finally {
  Remove-Item Env:RUN_QDRANT_INTEGRATION
}

$env:RUN_VECTOR_SEARCH_INTEGRATION = "1"
try {
  node --env-file=.env.local --test tests/search-vectors.integration.test.mjs
} finally {
  Remove-Item Env:RUN_VECTOR_SEARCH_INTEGRATION
}

$env:RUN_ANSWER_INTEGRATION = "1"
try {
  node --env-file=.env.local --test tests/generate-answer.integration.test.mjs
} finally {
  Remove-Item Env:RUN_ANSWER_INTEGRATION
}
```

</details>

## Manual application check

1. Configure private services, run `npm run ingest`, then `npm run dev`.
2. Open [localhost:3000](http://localhost:3000) and ask “What is the TaskFlow API rate limit? Cite the source.”
3. Confirm that text appears incrementally and inspect the completed answer's Sources list. The API guide fixture identifies page 3 as relevant evidence; exact model wording and label numbers can vary.
4. After availability checking completes, open a source. Confirm that the original PDF opens and the viewer navigates to the physical page when supported.
5. Reload, verify that the answer and citations remain, then send a second self-contained question. Earlier source lists should remain attached to their answers.
6. Use **New chat** to clear history. During another request, reset the chat to confirm late text does not repopulate it.
7. Send `{ "question": " " }` to `/api/chat` and confirm a safe 400 validation response. Inspect [diagnostic headers](api.md#diagnostic-headers) for a valid request.

The [sample-question fixture](../tests/fixtures/rag/taskflow-questions.json) provides expected evidence for manual checks; it is not a benchmark or a measured accuracy report.

## Production compilation

```bash
npm run build
npm start
```

The existing documentation recorded a Windows Turbopack CSS-worker failure and a successful `npm run build -- --webpack` workaround. See [build troubleshooting](deployment.md#production-build) before changing bundler configuration. Production compilation can need network access for the configured Google fonts.
