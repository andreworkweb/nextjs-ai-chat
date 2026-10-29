/** Text from one physical PDF page, or the single logical page of a text file. */
export interface ParsedPage {
  /** SHA-256 of the original file bytes, independent of its name or location. */
  documentId: string;
  sourceName: string;
  /** One-based physical page number. TXT and Markdown files use page 1. */
  pageNumber: number;
  text: string;
}

/** A searchable passage from exactly one physical source page. */
export interface Chunk extends ParsedPage {
  /** Deterministic UUID derived from the document, page, index, and chunk text. */
  id: string;
  /** Zero-based position within this page; order by pageNumber, then chunkIndex. */
  chunkIndex: number;
}

/** A chunk and its validated embedding, ready for vector storage. */
export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

/** A ranked passage with its original source metadata, ready for citations. */
export interface VectorSearchResult extends ParsedPage {
  /** Original chunk ID from the payload, independent of the scoped point ID. */
  chunkId: string;
  chunkIndex: number;
  /** One-based physical page, also retained as pageNumber for ParsedPage users. */
  page: number;
  /** Cosine similarity; larger scores indicate greater relevance. */
  score: number;
}

/** Original search metadata, plus a real Cohere score only when reranking succeeds. */
export interface RerankedChunk extends VectorSearchResult {
  rerankScore?: number;
}

export type CitationLabel = `[S${number}]`;

/** Real source identity for a citation present in the constructed prompt. */
export interface CitationSource {
  documentId: string;
  sourceName: string;
  chunkId: string;
  chunkIndex: number;
  pageNumber: number;
  page: number;
}

export interface RagPromptMessage {
  role: "system" | "user";
  content: string;
}

export interface BuiltPrompt {
  messages: RagPromptMessage[];
  sources: Partial<Record<CitationLabel, CitationSource>>;
  /** Conservative budget units, not an exact model-specific tokenizer count. */
  estimatedTokens: number;
  tokenBudget: number;
  includedChunkCount: number;
  omittedChunkCount: number;
}
