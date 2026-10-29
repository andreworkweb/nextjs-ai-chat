# Deployment and troubleshooting

[← README](../README.md) · [Configuration](configuration.md) · [Testing](testing.md)

The web application reads a pre-indexed Qdrant Cloud collection. Ingestion runs separately on a machine with source documents and write-capable credentials; visitors do not install Qdrant or run indexing.

## Production build

Use Node.js 24 and the committed npm lockfile:

```bash
npm ci
npm run build
npm start
```

`build` runs `next build`; `start` runs `next start`. The application uses `next/font` to load Geist and Geist Mono, so production compilation may need access to the font service. Provider calls and indexing are not part of the build command.

The previous README recorded a **Windows Turbopack CSS-worker startup crash** and a successful Webpack build. Preserve the alternative if you encounter that environment-specific failure:

```bash
npm run build -- --webpack
npm start
```

That note is historical troubleshooting, not a guarantee that every current build fails with Turbopack. This documentation update does not change the bundler configuration.

## Vercel configuration

1. Import the repository into a Vercel project and select a Node.js runtime compatible with the repository's Node.js 24 workflow.
2. In **Settings → Environment Variables**, add `OPENROUTER_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, and `QDRANT_COLLECTION` for Production and any Preview environments that need retrieval.
3. Add matching `RAG_EMBEDDING_MODEL` / `RAG_EMBEDDING_DIMENSIONS` overrides if ingestion used nondefault values. Copy any desired retrieval, prompt, answer-model, and optional reranking settings from the [configuration reference](configuration.md).
4. Store credentials as secret/sensitive values using the environment protections available in your project. Never expose them through `NEXT_PUBLIC_`.
5. Run ingestion separately against the intended cloud collection and verify results. Use a write-capable key for that operation; prefer a collection-scoped read-only key for the deployed web application.
6. Deploy, then redeploy after changing server environment settings. Check the stream and original-PDF routes in the deployed application.

The original README linked Vercel's [Config and Secret environment variable types](https://vercel.com/changelog/environment-variables-now-use-config-and-secret-types). Environment-management UI may evolve; the requirement is private runtime access to credentials, not a specific UI label.

This repository has no platform duration override. Its route deadline is 180 seconds; the actual hosting-plan/function limits may be shorter. Ensure the selected host can serve Node.js routes and stream SSE without buffering or caching. [Next.js deployment guide](https://nextjs.org/docs/app/building-your-application/deploying)

## Original PDF delivery

[`next.config.ts`](../next.config.ts) explicitly includes only the allowlisted originals under `data/documents/taskflow/` in the document route's server file trace. Keep those tracked originals in the deployment. The document resolver checks their content hashes at request time.

The copies under `public/documents/taskflow/` are already public static assets. Removing a PDF from the API allowlist does not make a tracked static copy private. Changed sample PDFs require deliberate hash/allowlist updates and re-ingestion before citations can link to the new version.

There is no authentication/session document policy in this checkout. Private/unlisted PDFs are denied by the download route, but the chat endpoint searches the configured collection without an authenticated scope. Add authorization before indexing restricted material into a collection used by a public deployment.

## Troubleshooting

| Symptom | Explanation and action |
| :--- | :--- |
| Node cannot run `.ts` or recognize the environment-file flag | Use the documented Node.js 24 runtime, then reinstall with `npm ci`. |
| Ingestion reports missing configuration | Fill the required server variables. The template's `QDRANT_COLLECTION` value is a suggestion; code requires an explicit value. |
| `CONFIGURATION_ERROR` for `QDRANT_URL` | Use the actual HTTPS cluster endpoint ending in `.cloud.qdrant.io`, without credentials, query, fragment, or path. Localhost/Docker endpoints are rejected. |
| Ingestion cannot create/index/write | Check cluster network access and a write-capable key. Ordinary search uses an existing collection and does not initialize one. |
| `COLLECTION_MISMATCH` | Use one unnamed Cosine vector with the configured dimensions and keyword payload indexes. Prefer a new collection for another embedding model. The script does not destroy incompatible data. |
| Embedding authentication or request rejection | Verify OpenRouter key/model access, output dimensions, and full-input token length. A separate OpenAI key is not used. |
| Embedding input exceeds context | Reduce chunk size and overlap as appropriate. The default Liquid model has a 512-token input limit; the chunker measures string length. Query text is embedded whole and is also subject to that limit. |
| `OCR_REQUIRED` or protected PDF error | Supply a text-bearing, unlocked PDF. OCR/password removal is not implemented in the pipeline. |
| Old text remains after renaming/removing a file | Ingestion only cleans revisions for successfully processed source paths. Retired source paths need deliberate database cleanup. |
| `503 RAG_UNAVAILABLE` | Check query embedding, Qdrant access, collection existence, dimensions, and ingestion results. Retrieval errors do not fall back to general-knowledge generation. |
| Insufficient-evidence text | Inspect the index, `RAG_SEARCH_MIN_SCORE`, and the context budget. Empty results or no fitting passages intentionally bypass the LLM. |
| Reranking stays `original` | It is off by default. Check the key, enabled flag, model ID, timeout, and accepted ranges. Optional failures fall back safely. |
| Provider model unavailable or answer fails | Choose an accessible OpenRouter `LLM_MODEL`, check quotas, and keep input/output budgets within its limits. Model defaults do not guarantee availability. |
| Stream ends before completion | Inspect the safe SSE error. Check timeouts, provider connectivity, and host streaming limits; incomplete turns are not committed as successful answers. |
| Follow-up question misses earlier context | Earlier turns remain visible but are not sent to the current answer model. Restate the subject in the question. |
| Citation has no link | It may refer to text or an unlisted/custom PDF. Only the explicitly public samples with matching original bytes, ID, and successful HEAD checks link. |
| Document route returns 404 | Missing, changed, invalid, private, and unlisted files intentionally share the same response. Check the allowlist, original hash, and deployment trace. |
| PDF opens without page navigation | `#page=N` depends on browser PDF viewer support; the source list still shows the physical page. |
| History does not survive reload | Enable browser storage. Quota/privacy restrictions use in-memory chat and surface a storage error. **New chat** resets invalid saved history and clears the transcript. |
| Another tab prevents sending | Web Locks can coordinate one active send per browser profile. Wait for the other request or reset the conversation deliberately. |
| Windows tests fail creating a symlink | Grant temporary symlink permission or enable Developer Mode; see the [testing guide](testing.md#default-checks). |

## Further reading

- [Next.js documentation](https://nextjs.org/docs) and [Learn Next.js](https://nextjs.org/learn)
- [Geist font](https://vercel.com/font)
- [Qdrant collection configuration](https://qdrant.tech/documentation/manage-data/collections/), [query API](https://api.qdrant.tech/api-reference/search/query-points), and [filtering](https://qdrant.tech/documentation/search/filtering/)
- [Cohere Rerank API](https://docs.cohere.com/reference/rerank) and [model catalog](https://docs.cohere.com/docs/models)
