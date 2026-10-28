import type { ParsedPage } from "./types";

function normalizePageText(text: string): string {
  const cleaned = text
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) => {
      if (character === "\n" || character === "\t") return character;
      if (character === "\v" || character === "\u0085") return "\n";
      return character === "\f" ? "\n\n" : "";
    })
    .replace(/\u2028/gu, "\n")
    .replace(/\u2029/gu, "\n\n");

  const lines: string[] = [];
  const pendingBlankLines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let previousIndented = false;

  for (const line of cleaned.split("\n")) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      // Spacing and blank lines inside code can be part of a string literal.
      lines.push(line);
      if (delimiter && delimiter[1][0] === fence.marker
        && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = undefined;
      }
      continue;
    }
    if (!line.trim()) {
      pendingBlankLines.push(line);
      continue;
    }

    const indented = /^(?: {4}|\t)/u.test(line);
    if (pendingBlankLines.length > 0 && lines.length > 0) {
      if (previousIndented && indented) {
        for (const blankLine of pendingBlankLines) lines.push(blankLine);
      } else {
        lines.push("");
      }
    }
    pendingBlankLines.length = 0;
    previousIndented = indented;

    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      previousIndented = false;
      lines.push(line);
      continue;
    }
    if (indented) {
      // Preserve code indentation and aligned content rather than guessing.
      lines.push(line);
      continue;
    }

    const indentation = line.match(/^[ \t]*/u)?.[0] ?? "";
    const content = line.slice(indentation.length);
    const hardBreak = / {2,}$/u.test(content) ? "  " : "";
    const normalized = content.trimEnd().replace(
      /(`+)(.*?)\1(?!`)|[^\S\n]+/gu,
      (match: string, codeDelimiter: string | undefined) => codeDelimiter ? match : " ",
    );
    // Two trailing spaces encode a meaningful Markdown line break.
    lines.push(`${indentation}${normalized}${hardBreak}`);
  }

  return lines.join("\n");
}

/** Clean page text without mutating input pages, metadata, or page order. */
export function normalizeText(pages: readonly ParsedPage[]): ParsedPage[] {
  if (!Array.isArray(pages)) {
    throw new TypeError("Expected an array of ParsedPage objects.");
  }

  return pages.map((page: ParsedPage, index: number) => {
    if (!page || typeof page.text !== "string") {
      throw new TypeError(`ParsedPage at index ${index} must contain a text string.`);
    }
    return { ...page, text: normalizePageText(page.text) };
  });
}
