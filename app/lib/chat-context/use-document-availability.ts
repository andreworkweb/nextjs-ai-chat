"use client";

import { useEffect, useRef, useState } from "react";
import { documentPath, resolveCitations } from "./citations";
import type { Conversation } from "./types";

/** Background availability checks never block chat or change its SSE protocol. */
export function useDocumentAvailability(conversation: Conversation | null) {
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const checked = useRef(new Map<string, boolean>());
  const ids = [...new Set((conversation?.turns ?? []).flatMap((turn) =>
    resolveCitations(turn.assistant?.content ?? "", turn.assistant?.citations)
      .map(({ documentId }) => documentId).filter((id) => documentPath(id) !== undefined)))].sort().join(",");

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    for (const id of ids ? ids.split(",") : []) {
      if (checked.current.has(id)) continue;
      void fetch(documentPath(id)!, {
        method: "HEAD", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      }).then((response) => response.ok && response.headers.get("Content-Type")?.split(";", 1)[0] === "application/pdf")
        .catch(() => false).then((accessible) => {
          if (disposed) return;
          checked.current.set(id, accessible);
          setAvailable((current) => ({ ...current, [id]: accessible }));
        });
    }
    return () => { disposed = true; controller.abort(); };
  }, [ids]);

  return available;
}
