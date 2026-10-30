import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentExtractionError, extractText } from "../src/lib/rag/extract-text.ts";
import { EmbeddingGenerationError, generateEmbeddings } from "../src/lib/rag/generate-embeddings.ts";
import { splitText } from "../src/lib/rag/split-text.ts";
import { ensureQdrantCollection, getQdrantConnection, QdrantStorageError } from "../src/lib/rag/qdrant.ts";
import type { QdrantConnection } from "../src/lib/rag/qdrant.ts";
import { storeEmbeddings } from "../src/lib/rag/store-embeddings.ts";

export interface IngestedFile {
  sourceName: string;
  status: "processed" | "failed" | "skipped";
  pages: number;
  chunks: number;
  verified: number;
  error?: string;
}

export interface IngestionOptions {
  directory?: string;
  connection?: QdrantConnection;
  embed?: typeof generateEmbeddings;
  onProgress?: (file: IngestedFile) => void;
}

function safeError(error: unknown): string {
  if (error instanceof QdrantStorageError || error instanceof DocumentExtractionError || error instanceof EmbeddingGenerationError) {
    return error.message;
  }
  return "An unexpected ingestion error occurred. No credentials or document contents were logged.";
}

async function documentFiles(directory: string): Promise<{ file: string; supported: boolean }[]> {
  const files: { file: string; supported: boolean }[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await documentFiles(file));
    else if (entry.isFile()) files.push({ file, supported: [".pdf", ".txt", ".md", ".markdown"].includes(path.extname(file).toLowerCase()) });
    // Symlinks are not followed outside the configured document directory.
  }
  return files;
}

/** Execute the existing pipeline locally, writing and verifying vectors remotely. */
export async function ingestDocuments(options: IngestionOptions = {}) {
  const directory = options.directory ?? fileURLToPath(new URL("../data/documents/", import.meta.url));
  const connection = options.connection ?? getQdrantConnection();
  let discovered: Awaited<ReturnType<typeof documentFiles>>;
  try {
    discovered = await documentFiles(directory);
  } catch {
    throw new QdrantStorageError("INVALID_INPUT", "The data/documents directory must exist and be readable.");
  }
  if (!discovered.some((entry) => entry.supported)) {
    throw new QdrantStorageError("INVALID_INPUT", "No PDF, TXT, or Markdown documents were found in data/documents.");
  }
  // Reject missing access or incompatible collections before generating embeddings.
  await ensureQdrantCollection(connection);
  const files: IngestedFile[] = [];
  for (const { file, supported } of discovered) {
    const sourceName = path.relative(directory, file).split(path.sep).join("/");
    const result: IngestedFile = { sourceName, status: supported ? "failed" : "skipped", pages: 0, chunks: 0, verified: 0 };
    if (supported) {
      try {
        // extractText already performs Step 3 normalization without re-cleaning.
        const pages = await extractText(file, sourceName);
        result.pages = pages.length;
        const chunks = await splitText(pages);
        result.chunks = chunks.length;
        const embedded = await (options.embed ?? generateEmbeddings)(chunks);
        const stored = await storeEmbeddings(embedded, { connection });
        result.verified = stored.reduce((sum, source) => sum + source.verified, 0);
        result.status = "processed";
      } catch (error) {
        result.error = safeError(error);
      }
    }
    files.push(result);
    options.onProgress?.(result);
  }
  return {
    processedFiles: files.filter((file) => file.status === "processed").length,
    skippedFiles: files.filter((file) => file.status === "skipped").length,
    errors: files.filter((file) => file.status === "failed").length,
    chunks: files.filter((file) => file.status === "processed").reduce((sum, file) => sum + file.chunks, 0),
    verified: files.reduce((sum, file) => sum + file.verified, 0),
    files,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ingestDocuments({ onProgress: (file) => console.log(JSON.stringify({ type: "file", ...file })) })
    .then(({ processedFiles, skippedFiles, errors, chunks, verified }) => {
      console.log(JSON.stringify({ type: "summary", processedFiles, skippedFiles, errors, chunks, verified }));
      if (errors) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(JSON.stringify({ type: "error", error: safeError(error) }));
      process.exitCode = 1;
    });
}
