import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { PDFParse, PasswordException } from "pdf-parse";
import type { ParsedPage } from "./types";

export type ExtractionErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_READ_FAILED"
  | "EMPTY_FILE"
  | "INVALID_TEXT"
  | "INVALID_PDF"
  | "PDF_PASSWORD_REQUIRED"
  | "PDF_PARSE_FAILED"
  | "OCR_REQUIRED";

export class DocumentExtractionError extends Error {
  readonly code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DocumentExtractionError";
    this.code = code;
  }
}

function extractPlainText(data: Buffer, sourceName: string): string {
  let text: string;
  try {
    // Fatal decoding prevents silently ingesting corrupt or non-UTF-8 bytes.
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch (cause) {
    throw new DocumentExtractionError(
      "INVALID_TEXT",
      `"${sourceName}" is not valid UTF-8 text. Save it as UTF-8 and try again.`,
      cause,
    );
  }

  if (text.includes("\0")) {
    throw new DocumentExtractionError(
      "INVALID_TEXT",
      `"${sourceName}" contains binary data rather than plain text.`,
    );
  }
  if (!text.trim()) {
    throw new DocumentExtractionError(
      "EMPTY_FILE",
      `"${sourceName}" is empty or contains only whitespace.`,
    );
  }

  // Preserve Markdown formatting and text whitespace; never write to the source.
  return text;
}

async function extractPdf(
  data: Buffer,
  documentId: string,
  sourceName: string,
): Promise<ParsedPage[]> {
  // PDF readers permit a small prefix before the signature.
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new DocumentExtractionError(
      "INVALID_PDF",
      `"${sourceName}" is not a valid PDF: the PDF header is missing.`,
    );
  }

  const parser = new PDFParse({ data, isEvalSupported: false, verbosity: 0 });
  let extractionFailed = false;
  try {
    // pdf-parse v2 extracts each physical page and supplies its original number.
    const result = await parser.getText({ pageJoiner: "" });
    const pages: ParsedPage[] = result.pages.map((page) => ({
      documentId,
      sourceName,
      pageNumber: page.num,
      text: page.text.trim(),
    }));

    if (!pages.some((page) => page.text.length > 0)) {
      throw new DocumentExtractionError(
        "OCR_REQUIRED",
        `"${sourceName}" has no extractable text. It may be scanned or image-only; OCR may be required.`,
      );
    }

    // Keep blank pages in mixed documents so physical page metadata stays intact.
    return pages;
  } catch (cause) {
    extractionFailed = true;
    if (cause instanceof DocumentExtractionError) throw cause;
    if (cause instanceof PasswordException) {
      throw new DocumentExtractionError(
        "PDF_PASSWORD_REQUIRED",
        `"${sourceName}" is password-protected. Provide an unlocked PDF.`,
        cause,
      );
    }
    throw new DocumentExtractionError(
      "PDF_PARSE_FAILED",
      `Unable to extract text from "${sourceName}". The PDF may be invalid or corrupted.`,
      cause,
    );
  } finally {
    try {
      await parser.destroy();
    } catch (cause) {
      // A cleanup failure must not replace the useful extraction/OCR error.
      if (!extractionFailed) {
        throw new DocumentExtractionError(
          "PDF_PARSE_FAILED",
          `Unable to release PDF parser resources for "${sourceName}".`,
          cause,
        );
      }
    }
  }
}

/**
 * Read a local document on the Node.js server without changing the original.
 * TXT and Markdown are UTF-8 and return one logical page, numbered 1.
 * sourceName defaults to the filename and can preserve an original upload name.
 */
export async function extractText(
  filePath: string,
  sourceName?: string,
): Promise<ParsedPage[]> {
  if (typeof filePath !== "string" || !filePath.trim() || filePath.includes("\0")) {
    throw new DocumentExtractionError("INVALID_INPUT", "A valid local file path is required.");
  }
  if (sourceName !== undefined && (typeof sourceName !== "string" || !sourceName.trim())) {
    throw new DocumentExtractionError("INVALID_INPUT", "sourceName must be a non-empty string.");
  }

  const name = sourceName ?? basename(filePath);
  const extension = extname(filePath).toLowerCase();
  if (![".pdf", ".txt", ".md", ".markdown"].includes(extension)) {
    throw new DocumentExtractionError(
      "UNSUPPORTED_FILE_TYPE",
      `Unsupported file type "${extension || "(none)"}". Supported types: PDF, TXT, and Markdown (.md, .markdown).`,
    );
  }

  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" || code === "ENOTDIR"
      ? "File not found."
      : code === "EISDIR"
        ? "The path must point to a regular file."
        : "Check that the file exists and is readable.";
    throw new DocumentExtractionError(
      "FILE_READ_FAILED",
      `Unable to read "${name}". ${reason}`,
      cause,
    );
  }

  if (data.length === 0) {
    throw new DocumentExtractionError("EMPTY_FILE", `"${name}" is empty.`);
  }

  // Hash before passing bytes to a parser that may transfer its input buffer.
  const documentId = createHash("sha256").update(data).digest("hex");
  if (extension === ".pdf") return extractPdf(data, documentId, name);

  return [{ documentId, sourceName: name, pageNumber: 1, text: extractPlainText(data, name) }];
}
