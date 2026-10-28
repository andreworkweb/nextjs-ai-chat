/** Text from one physical PDF page, or the single logical page of a text file. */
export interface ParsedPage {
  /** SHA-256 of the original file bytes, independent of its name or location. */
  documentId: string;
  sourceName: string;
  /** One-based physical page number. TXT and Markdown files use page 1. */
  pageNumber: number;
  text: string;
}
