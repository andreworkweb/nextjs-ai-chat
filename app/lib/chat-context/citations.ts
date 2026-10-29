import type { ChatCitation } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate optional stream/storage metadata without discarding the answer. */
export function parseCitations(value: unknown): ChatCitation[] {
  if (!Array.isArray(value) || value.length > 1000) return [];
  const parsed = new Map<string, ChatCitation>();
  const conflicts = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.label !== "string" || !/^\[S[1-9]\d{0,3}\]$/u.test(item.label)
      || Number(item.label.slice(2, -1)) > 1000
      || typeof item.documentId !== "string" || !item.documentId.trim() || item.documentId.length > 1024
      || typeof item.chunkId !== "string" || !item.chunkId.trim() || item.chunkId.length > 1024
      || typeof item.sourceName !== "string" || item.sourceName.length > 4096 || /[\u0000-\u001f\u007f]/u.test(item.sourceName)
      || !Number.isSafeInteger(item.pageNumber) || (item.pageNumber as number) < 1) continue;
    const sourceName = item.sourceName.split(/[\\/]/u).at(-1);
    if (!sourceName?.trim() || sourceName === "." || sourceName === ".." || conflicts.has(item.label)) continue;
    const citation: ChatCitation = {
      label: item.label as ChatCitation["label"], documentId: item.documentId,
      chunkId: item.chunkId, sourceName, pageNumber: item.pageNumber as number,
    };
    const previous = parsed.get(item.label);
    if (previous && (previous.documentId !== citation.documentId || previous.chunkId !== citation.chunkId
      || previous.sourceName !== citation.sourceName || previous.pageNumber !== citation.pageNumber)) {
      parsed.delete(item.label);
      conflicts.add(item.label);
    } else parsed.set(item.label, citation);
  }
  return [...parsed.values()];
}

/** Only exact markers present in this answer and this response's map resolve. */
export function resolveCitations(text: string, metadata: unknown): ChatCitation[] {
  const available = new Map(parseCitations(metadata).map((citation) => [citation.label, citation]));
  if (!available.size) return [];
  const resolved = new Map<string, ChatCitation>();
  for (const match of text.matchAll(/\[S[1-9]\d{0,3}\]/gu)) {
    const citation = available.get(match[0] as ChatCitation["label"]);
    if (citation) resolved.set(citation.label, citation);
  }
  return [...resolved.values()];
}
