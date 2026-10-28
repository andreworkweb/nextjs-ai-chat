"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readChatStream } from "../read-chat-stream";
import {
  createConversation,
  getConversationStorageKey,
  getOrCreateOwnerId,
  loadConversation,
  resetConversation,
  saveConversation,
} from "./storage";
import {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_BYTES,
  type ChatMessage,
  type ChatRequest,
  type ChatTurn,
  type Conversation,
} from "./types";

type ActiveRequest = {
  controller: AbortController;
  conversationId: string;
};

function latestReply(conversation: Conversation): string {
  return conversation.turns.findLast((turn) => turn.status === "complete")
    ?.assistant?.content ?? "";
}

// Send a bounded, chronological suffix. Keep the full transcript in storage.
function recentHistory(conversation: Conversation): ChatMessage[] {
  const history: ChatMessage[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;

  for (let index = conversation.turns.length - 1; index >= 0; index--) {
    const turn = conversation.turns[index];
    if (turn.status !== "complete" || !turn.assistant) continue;

    const turnBytes = encoder.encode(turn.user.content).length
      + encoder.encode(turn.assistant.content).length;
    if (history.length + 2 > MAX_HISTORY_MESSAGES
      || bytes + turnBytes > MAX_HISTORY_BYTES) break;

    history.unshift(turn.user, turn.assistant);
    bytes += turnBytes;
  }

  return history;
}

function storageMessage(error: unknown): string {
  return error instanceof Error ? error.message
    : "Chat history could not be saved. It will only last while this page is open.";
}

export function useChat() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const conversationRef = useRef<Conversation | null>(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const persistenceRef = useRef(true);
  const mountedRef = useRef(false);

  const replaceConversation = useCallback((next: Conversation) => {
    conversationRef.current = next;
    setConversation(next);
  }, []);

  const persist = useCallback((next: Conversation) => {
    replaceConversation(next);
    if (!persistenceRef.current) return;

    try {
      saveConversation(next);
      persistenceRef.current = true;
      setStorageError("");
    } catch (error) {
      persistenceRef.current = false;
      setStorageError(storageMessage(error));
    }
  }, [replaceConversation]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    // Read browser storage after hydration, including React's development remount.
    queueMicrotask(() => {
      if (disposed) return;

      let ownerId = crypto.randomUUID();
      try {
        ownerId = getOrCreateOwnerId();
        const saved = loadConversation(ownerId);
        const restored = saved ?? createConversation(ownerId);
        const recovered: Conversation = {
          ...restored,
          turns: restored.turns.map((turn) => turn.status === "pending"
            ? { ...turn, status: "interrupted" } : turn),
        };
        replaceConversation(recovered);
        setReply(latestReply(recovered));
        // A different tab may still own this pending request. Recover it locally
        // without writing over that tab's active turn.
        if (!saved) persist(recovered);
      } catch (error) {
        persistenceRef.current = false;
        replaceConversation(createConversation(ownerId));
        setStorageError(storageMessage(error));
      }
      setReady(true);
    });

    function onStorage(event: StorageEvent) {
      const current = conversationRef.current;
      if (!current || (event.key !== null
        && event.key !== getConversationStorageKey(current.ownerId))) return;

      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      setLoading(false);
      setRequestError("");

      try {
        const incoming = loadConversation(current.ownerId)
          ?? createConversation(current.ownerId);
        persistenceRef.current = true;
        setStorageError("");
        replaceConversation(incoming);
        setReply(latestReply(incoming));
        if (incoming.id !== current.id) setMessage("");
      } catch (error) {
        persistenceRef.current = false;
        setStorageError(storageMessage(error));
      }
    }

    window.addEventListener("storage", onStorage);
    return () => {
      disposed = true;
      mountedRef.current = false;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      window.removeEventListener("storage", onStorage);
    };
  }, [persist, replaceConversation]);

  const askAI = useCallback(async () => {
    const original = conversationRef.current;
    const text = message.trim();
    if (!ready || !original || !text || activeRequestRef.current) return;
    if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
      setRequestError("Your message is too long. Please shorten it and try again.");
      return;
    }

    const request: ActiveRequest = {
      controller: new AbortController(),
      conversationId: original.id,
    };
    // React state alone does not lock two submissions in the same event loop.
    activeRequestRef.current = request;
    setLoading(true);
    setRequestError("");

    function isCurrent() {
      return mountedRef.current && activeRequestRef.current === request
        && conversationRef.current?.id === request.conversationId;
    }

    async function generate() {
      if (!isCurrent()) return;
      let current = conversationRef.current!;
      if (persistenceRef.current) {
        // Another tab may have finished a turn since this page last rendered.
        try {
          const saved = loadConversation(current.ownerId);
          if (!saved || saved.id !== current.id) {
            const next = saved ?? resetConversation(current.ownerId);
            replaceConversation(next);
            setReply(latestReply(next));
            setRequestError("The conversation changed in another tab. Please send your message again.");
            return;
          }
          current = saved;
        } catch (error) {
          persistenceRef.current = false;
          setStorageError(storageMessage(error));
        }
      }

      // Once the send lock is held, a leftover pending turn can be recovered.
      current = {
        ...current,
        turns: current.turns.map((turn) => turn.status === "pending"
          ? { ...turn, status: "interrupted" } : turn),
      };

      const previous = current.turns.at(-1);
      const retry = previous && previous.status !== "complete"
        && previous.user.content === text;
      const turnId = retry ? previous.id : crypto.randomUUID();
      const turn: ChatTurn = {
        id: turnId,
        user: { id: `${turnId}:user`, role: "user", content: text },
        status: "pending",
      };
      const pending: Conversation = {
        ...current,
        turns: retry ? [...current.turns.slice(0, -1), turn] : [...current.turns, turn],
      };
      const body: ChatRequest = {
        message: text,
        messageId: turn.user.id,
        conversationId: current.id,
        history: recentHistory(current),
      };

      function canSaveResult() {
        if (!isCurrent()) return false;
        if (!persistenceRef.current) return true;

        try {
          const saved = loadConversation(current.ownerId);
          const last = saved?.turns.at(-1);
          if (!saved || saved.id !== current.id
            || last?.id !== turnId || last.status !== "pending") {
            const next = saved ?? createConversation(current.ownerId);
            replaceConversation(next);
            setReply(latestReply(next));
            setMessage("");
            return false;
          }
        } catch (error) {
          // A storage failure must not discard a successfully generated answer.
          persistenceRef.current = false;
          setStorageError(storageMessage(error));
        }
        return true;
      }

      persist(pending);
      setMessage("");
      setReply("");

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, question: body.message }),
          signal: request.controller.signal,
        });
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null);
          const detail = payload && typeof payload === "object"
            && "error" in payload && typeof payload.error === "string"
            ? payload.error : "Failed to generate response. Please try again.";
          throw new Error(detail);
        }
        if (!response.body) throw new Error("Response body is not readable");

        let answer = "";
        await readChatStream(response.body, (content) => {
          if (!isCurrent()) return;
          answer += content;
          setReply(answer);
        });
        if (!isCurrent()) return;
        if (!answer.trim()) throw new Error("The AI returned an empty response. Please try again.");

        // Check both success and failure before saving; storage events may lag.
        if (!canSaveResult()) return;
        persist({
          ...pending,
          turns: pending.turns.map((item) => item.id === turnId ? {
            ...item,
            assistant: { id: `${turnId}:assistant`, role: "assistant", content: answer },
            status: "complete",
          } : item),
        });
      } catch (error) {
        if (!canSaveResult()) return;
        persist({
          ...pending,
          turns: pending.turns.map((item) => item.id === turnId
            ? { ...item, status: "failed" } : item),
        });
        // Keep the failed turn's ID on retry without replacing a newer draft.
        setMessage((draft) => draft || text);
        throw error;
      }
    }

    try {
      if (typeof navigator !== "undefined" && navigator.locks && persistenceRef.current) {
        await navigator.locks.request(
          `${getConversationStorageKey(original.ownerId)}:send`,
          { ifAvailable: true, mode: "exclusive" },
          async (lock) => {
            if (!lock) throw new Error("A response is being generated in another tab. Please wait.");
            await generate();
          },
        );
      } else {
        await generate();
      }
    } catch (error) {
      if (isCurrent()) {
        setRequestError(error instanceof Error ? error.message : "Something went wrong");
      }
    } finally {
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [message, ready, persist, replaceConversation]);

  const clearConversation = useCallback(() => {
    const current = conversationRef.current;
    if (!current) return;
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    try {
      replaceConversation(resetConversation(current.ownerId));
      persistenceRef.current = true;
      setStorageError("");
    } catch (error) {
      replaceConversation(createConversation(current.ownerId));
      persistenceRef.current = false;
      setStorageError(storageMessage(error));
    }
    setMessage("");
    setReply("");
    setLoading(false);
    setRequestError("");
  }, [replaceConversation]);

  return {
    message,
    setMessage,
    reply,
    loading,
    ready,
    error: [requestError, storageError].filter(Boolean).join(" "),
    conversation,
    askAI,
    clearConversation,
  };
}
