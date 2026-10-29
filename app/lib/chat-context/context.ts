import type { ChatMessage, ChatRequest } from "./types";
import {
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_BYTES,
} from "./types.ts";

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_COMPLETION_TOKENS = 8192;

// The configured model currently supports 1,000,000 tokens. Keep a much smaller
// application budget, estimating one token per UTF-8 byte rather than chars / 4.
// This is deliberately conservative, not an exact tokenizer implementation.
const APPLICATION_CONTEXT_TOKENS = 64 * 1024;
const SAFETY_TOKENS = 2048;
const MESSAGE_OVERHEAD_TOKENS = 32;
const INPUT_BUDGET =
  APPLICATION_CONTEXT_TOKENS - MAX_COMPLETION_TOKENS - SAFETY_TOKENS;
const encoder = new TextEncoder();

export type ProviderMessage = Pick<ChatMessage, "role" | "content">;

/** Shared conservative estimate: UTF-8 content bytes plus message framing. */
export function estimateMessageTokens(message: { content: string }): number {
  return encoder.encode(message.content).byteLength + MESSAGE_OVERHEAD_TOKENS;
}

export class ChatContextError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatContextError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
  ) {
    throw new ChatContextError(`${label} is invalid`);
  }
  return value;
}

function validateText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChatContextError(`${label} is required`);
  }
  if (encoder.encode(value).byteLength > maxBytes) {
    throw new ChatContextError(`${label} is too long`, 413);
  }
  return value;
}

export function parseChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value)) {
    throw new ChatContextError("A JSON object is required");
  }

  const message = validateText(value.message, "Message", MAX_MESSAGE_BYTES);
  const messageId =
    value.messageId === undefined
      ? undefined
      : validateId(value.messageId, "Message ID");
  const conversationId =
    value.conversationId === undefined
      ? undefined
      : validateId(value.conversationId, "Conversation ID");
  const suppliedHistory = value.history === undefined ? [] : value.history;
  if (!Array.isArray(suppliedHistory)) {
    throw new ChatContextError("History must be an array");
  }
  if (suppliedHistory.length > MAX_HISTORY_MESSAGES) {
    throw new ChatContextError("Too many history messages", 413);
  }

  const history: ChatMessage[] = [];
  const seen = new Map<string, ChatMessage>();
  for (const entry of suppliedHistory) {
    if (
      !isRecord(entry) ||
      (entry.role !== "user" && entry.role !== "assistant")
    ) {
      throw new ChatContextError("History contains an invalid message role");
    }
    const id = validateId(entry.id, "History message ID");
    const content = validateText(
      entry.content,
      "History message",
      MAX_HISTORY_BYTES,
    );
    const existing = seen.get(id);
    if (existing) {
      if (existing.role !== entry.role || existing.content !== content) {
        throw new ChatContextError("History contains conflicting message IDs");
      }
      continue;
    }
    const parsed: ChatMessage = { id, role: entry.role, content };
    history.push(parsed);
    seen.set(id, parsed);
  }

  // Tolerate a caller that has already appended the pending user message.
  // Completed messages with the same ID must never generate a second answer.
  if (messageId && seen.has(messageId)) {
    const existing = seen.get(messageId)!;
    if (existing.role !== "user" || existing.content !== message) {
      throw new ChatContextError(
        "The current message ID conflicts with history",
      );
    }
    if (history.at(-1)?.id !== messageId) {
      throw new ChatContextError("This message already has a response", 409);
    }
    history.pop();
  }

  if (
    history.length % 2 !== 0 ||
    history.some(
      (entry, index) => entry.role !== (index % 2 === 0 ? "user" : "assistant"),
    )
  ) {
    throw new ChatContextError(
      "History must contain complete user and assistant turns",
    );
  }

  return { message, messageId, conversationId, history };
}

export function buildContext(request: ChatRequest): ProviderMessage[] {
  const history = request.history ?? [];
  const current: ProviderMessage = { role: "user", content: request.message };
  let remaining = INPUT_BUDGET - estimateMessageTokens(current);
  let historyBytes = 0;
  let start = history.length;

  // Select a contiguous suffix of complete turns. Never split a saved turn or
  // shorten the current message, and never delete the persisted transcript.
  for (let index = history.length - 2; index >= 0; index -= 2) {
    const pairBytes =
      encoder.encode(history[index].content).byteLength +
      encoder.encode(history[index + 1].content).byteLength;
    const pairCost = pairBytes + 2 * MESSAGE_OVERHEAD_TOKENS;
    if (pairCost > remaining || historyBytes + pairBytes > MAX_HISTORY_BYTES)
      break;
    remaining -= pairCost;
    historyBytes += pairBytes;
    start = index;
  }

  return [
    ...history.slice(start).map(({ role, content }) => ({ role, content })),
    current,
  ];
}

export async function readChatRequest(request: Request): Promise<ChatRequest> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new ChatContextError("The chat request is too large", 413);
  }
  if (!request.body) {
    throw new ChatContextError("A JSON request body is required");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let receivedBytes = 0;
  let text = "";

  try {
    while (true) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_REQUEST_BYTES) {
        throw new ChatContextError("The chat request is too large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (request.signal.aborted || error instanceof ChatContextError)
      throw error;
    throw new ChatContextError("The request body could not be read");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChatContextError("The request body must contain valid JSON");
  }
  return parseChatRequest(value);
}
