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
