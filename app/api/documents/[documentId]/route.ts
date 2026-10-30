import { readPublicDocument } from "../../../../src/lib/rag/documents.ts";

type DocumentContext = { params: Promise<{ documentId: string }> };

// Node.js is required by cacheComponents; route-level runtime exports are rejected.
async function serveDocument(context: DocumentContext, head: boolean): Promise<Response> {
  const { documentId } = await context.params;
  const document = await readPublicDocument(documentId);
  if (!document) {
    return new Response(head ? null : "Document not found or unavailable.", {
      status: 404, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
  return new Response(head ? null : new Uint8Array(document.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(document.bytes.length),
      "Content-Disposition": `inline; filename="${document.fileName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "frame-ancestors 'self'",
    },
  });
}

export async function GET(_request: Request, context: DocumentContext): Promise<Response> {
  return serveDocument(context, false);
}

export async function HEAD(_request: Request, context: DocumentContext): Promise<Response> {
  return serveDocument(context, true);
}
