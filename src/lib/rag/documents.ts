import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

export interface DocumentEntry {
  documentId: string;
  fileName: string;
  access: "public" | "private";
}

// These five PDFs already have tracked public/ copies. New ingestion does not
// grant download access. Private/unlisted documents always fail closed.
export const PUBLIC_DOCUMENTS: readonly Readonly<DocumentEntry>[] = Object.freeze(([
  { documentId: "4ec8a19f69f808cdd3cf3c86358adf8ad4375149d2eafb4f13cdad03478d9ede", fileName: "01_Product_Guide.pdf", access: "public" },
  { documentId: "a8412eca5370b21511625063f1c5b44db18359f491cbb5d378b91c95d8f6bef2", fileName: "02_Plans_and_Billing.pdf", access: "public" },
  { documentId: "6e88c38545db0c9edf1a023928a50c36edb5e583aeec4690155da6986b7f106d", fileName: "03_API_Guide.pdf", access: "public" },
  { documentId: "8be61fa98cdfc6b5dc988180b6395838b91b4c762e2bdd56365142080737bad3", fileName: "04_Troubleshooting.pdf", access: "public" },
  { documentId: "aaf123f32cc3378a91d146a1c166b801b3f1df37c67512a1a63b8025d962ce1e", fileName: "05_Release_Notes.pdf", access: "public" },
] satisfies DocumentEntry[]).map((entry) => Object.freeze(entry)));

interface DocumentOptions {
  /** Trusted server configuration, injectable for isolated filesystem tests. */
  directory?: string;
  documents?: readonly Readonly<DocumentEntry>[];
}

/** Resolve only approved IDs; filenames and paths never come from the request. */
export async function readPublicDocument(documentId: unknown, options: DocumentOptions = {}) {
  if (typeof documentId !== "string" || !/^[a-f0-9]{64}$/u.test(documentId)) return null;
  const entry = (options.documents ?? PUBLIC_DOCUMENTS).find((document) => document.documentId === documentId);
  if (!entry || entry.access !== "public" || !/^[a-zA-Z0-9_-]+\.pdf$/u.test(entry.fileName)) return null;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(options.directory ?? path.join(process.cwd(), "data/documents/taskflow"));
    const file = await realpath(path.join(root, entry.fileName));
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    handle = await open(file, "r");
    const stat = await handle.stat();
    const maxBytes = 32 * 1024 * 1024;
    if (!stat.isFile() || stat.size < 5 || stat.size > maxBytes) return null;
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
      || createHash("sha256").update(bytes).digest("hex") !== documentId) return null;
    return { bytes, fileName: entry.fileName };
  } catch {
    // Missing, inaccessible, changed, and unauthorized documents look identical.
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
