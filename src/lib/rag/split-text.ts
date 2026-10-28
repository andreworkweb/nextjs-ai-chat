import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Chunk, ParsedPage } from "./types";

export interface SplitTextOptions {
  /** Maximum characters per chunk. Defaults to RAG_CHUNK_SIZE or 1000. */
  chunkSize?: number;
  /** Target overlap. Defaults to RAG_CHUNK_OVERLAP or 200; must be < chunkSize. */
  chunkOverlap?: number;
}

const SENTENCE_SEPARATORS = [". ", "! ", "? "];

class SentenceBoundaryTextSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(text: string, separator: string): string[] {
    // The library's split("") fallback can divide a Unicode surrogate pair.
    if (separator === "") return Array.from(text);
    if (!SENTENCE_SEPARATORS.includes(separator)) {
      return super.splitOnSeparator(text, separator);
    }

    // LangChain v1 keeps separators at the start of the following split. Keep
    // sentence punctuation with its sentence instead, without discarding it.
    const parts = text.split(separator);
    return parts
      .map((part, index) => part + (index < parts.length - 1 ? separator : ""))
      .filter((part) => part.length > 0);
  }
}

function environmentInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new RangeError(`${name} must be a non-negative decimal integer.`);
  }
  return Number(value);
}

function chunkId(page: ParsedPage, chunkIndex: number, text: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["rag-chunk-v1", page.documentId, page.pageNumber, chunkIndex, text]))
    .digest();
  // UUIDv8 carries a custom deterministic hash and is a valid Qdrant point ID.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Split already-normalized pages independently, keeping citation metadata.
 * Sizes use JavaScript string length, not tokens. Overlap is a target and may
 * be smaller at paragraph/sentence boundaries. Input pages are never mutated.
 */
export async function splitText(
  pages: readonly ParsedPage[],
  options: SplitTextOptions = {},
): Promise<Chunk[]> {
  if (!Array.isArray(pages)) {
    throw new TypeError("Expected an array of normalized ParsedPage objects.");
  }
  const parsedPages: readonly ParsedPage[] = pages;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Chunking options must be an object.");
  }

  const chunkSize = options.chunkSize === undefined
    ? environmentInteger("RAG_CHUNK_SIZE", 1000)
    : options.chunkSize;
  const chunkOverlap = options.chunkOverlap === undefined
    ? environmentInteger("RAG_CHUNK_OVERLAP", 200)
    : options.chunkOverlap;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("chunkSize must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new RangeError("chunkOverlap must be a non-negative safe integer smaller than chunkSize.");
  }

  for (const [index, page] of parsedPages.entries()) {
    if (!page || typeof page.text !== "string") {
      throw new TypeError(`ParsedPage at index ${index} must contain a text string.`);
    }
    if (typeof page.documentId !== "string" || !page.documentId.trim()
      || typeof page.sourceName !== "string" || !page.sourceName.trim()
      || !Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1) {
      throw new TypeError(`ParsedPage at index ${index} requires documentId, sourceName, and a positive integer pageNumber.`);
    }
    if (chunkSize === 1 && Array.from(page.text).some((character) => character.length > 1)) {
      throw new RangeError("chunkSize must be at least 2 for text containing emoji or other supplementary Unicode characters.");
    }
  }

  const splitter = new SentenceBoundaryTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", ...SENTENCE_SEPARATORS, " ", ""],
    keepSeparator: true,
  });
  const chunks: Chunk[] = [];

  for (const page of parsedPages) {
    if (!page.text.trim()) continue;
    let texts: string[];
    try {
      texts = await splitter.splitText(page.text);
    } catch (cause) {
      throw new Error(`Unable to split page ${page.pageNumber} of "${page.sourceName}".`, { cause });
    }

    let chunkIndex = 0;
    for (const text of texts) {
      if (!text.trim()) continue;
      chunks.push({ ...page, id: chunkId(page, chunkIndex, text), chunkIndex, text });
      chunkIndex++;
    }
  }

  return chunks;
}
