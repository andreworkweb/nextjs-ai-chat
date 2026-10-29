import type { ChatMessage, ChatTurn, Conversation, TurnStatus } from "./types";
import { resolveCitations } from "./citations.ts";

const OWNER_STORAGE_KEY = "chat-context:owner:v1";
const INVALID_HISTORY =
  "Saved chat history is invalid. Start a new conversation to reset it.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
  );
}

function requireOwnerId(ownerId: string): void {
  if (!isIdentifier(ownerId)) {
    throw new Error("The chat history owner is invalid.");
  }
}

function getStorage(): Storage {
  if (typeof window === "undefined") {
    throw new Error("Chat history is only available in the browser.");
  }
  try {
    return window.localStorage;
  } catch {
    throw new Error("Browser storage is unavailable. Chat history cannot be saved.");
  }
}

function readValue(key: string): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    throw new Error("Browser storage is unavailable. Saved chat history cannot be read.");
  }
}

function writeValue(key: string, value: string): void {
  try {
    getStorage().setItem(key, value);
  } catch {
    throw new Error("Chat history could not be saved. Browser storage may be full or disabled.");
  }
}

function parseMessage(
  value: unknown,
  turnId: string,
  role: ChatMessage["role"],
): ChatMessage {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    value.id !== `${turnId}:${role}` ||
    value.role !== role ||
    typeof value.content !== "string" ||
    !value.content.trim()
  ) {
    throw new Error(INVALID_HISTORY);
  }
  const citations = role === "assistant" ? resolveCitations(value.content, value.citations) : [];
  return { id: value.id, role, content: value.content, ...(citations.length ? { citations } : {}) };
}

function isTurnStatus(value: unknown): value is TurnStatus {
  return (
    value === "pending" ||
    value === "complete" ||
    value === "failed" ||
    value === "interrupted"
  );
}

// Construct fresh objects so unvalidated fields never enter application state.
export function parseConversation(value: unknown, ownerId: string): Conversation {
  requireOwnerId(ownerId);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isIdentifier(value.id) ||
    value.ownerId !== ownerId ||
    !Array.isArray(value.turns)
  ) {
    throw new Error(INVALID_HISTORY);
  }

  const savedTurns = value.turns;
  const ids = new Set<string>();
  const turns: ChatTurn[] = savedTurns.map((turn: unknown, index: number) => {
    if (
      !isRecord(turn) ||
      !isIdentifier(turn.id) ||
      !isTurnStatus(turn.status) ||
      ids.has(turn.id) ||
      (turn.status === "pending" && index !== savedTurns.length - 1)
    ) {
      throw new Error(INVALID_HISTORY);
    }
    ids.add(turn.id);

    const user = parseMessage(turn.user, turn.id, "user");
    const assistant =
      turn.status === "complete"
        ? parseMessage(turn.assistant, turn.id, "assistant")
        : undefined;
    if (
      (turn.status !== "complete" && turn.assistant !== undefined) ||
      ids.has(user.id) ||
      (assistant !== undefined && ids.has(assistant.id))
    ) {
      throw new Error(INVALID_HISTORY);
    }
    ids.add(user.id);
    if (assistant) ids.add(assistant.id);

    return assistant
      ? { id: turn.id, user, assistant, status: turn.status }
      : { id: turn.id, user, status: turn.status };
  });

  return { version: 1, id: value.id, ownerId, turns };
}

export function getConversationStorageKey(ownerId: string): string {
  requireOwnerId(ownerId);
  return `chat-context:conversation:v1:${ownerId}`;
}

export function getOrCreateOwnerId(): string {
  const savedOwnerId = readValue(OWNER_STORAGE_KEY);
  if (savedOwnerId !== null) {
    if (!isIdentifier(savedOwnerId)) {
      throw new Error("The saved chat identity is invalid. Browser storage needs to be reset.");
    }
    return savedOwnerId;
  }

  // This identifies an anonymous browser profile, not an authenticated account.
  const ownerId = crypto.randomUUID();
  writeValue(OWNER_STORAGE_KEY, ownerId);
  return ownerId;
}

export function createConversation(ownerId: string): Conversation {
  requireOwnerId(ownerId);
  return { version: 1, id: crypto.randomUUID(), ownerId, turns: [] };
}

export function loadConversation(ownerId: string): Conversation | null {
  const saved = readValue(getConversationStorageKey(ownerId));
  if (saved === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch {
    throw new Error(INVALID_HISTORY);
  }
  return parseConversation(value, ownerId);
}

export function saveConversation(conversation: Conversation): void {
  const parsed = parseConversation(conversation, conversation.ownerId);
  writeValue(getConversationStorageKey(parsed.ownerId), JSON.stringify(parsed));
}

// Call only for an explicit reset. This also repairs an unavailable or malformed
// saved anonymous identity once browser storage becomes writable again.
export function resetConversation(ownerId: string): Conversation {
  const conversation = createConversation(ownerId);
  saveConversation(conversation);
  writeValue(OWNER_STORAGE_KEY, ownerId);
  return conversation;
}
