export const MAX_HISTORY_MESSAGES = 100;
export const MAX_HISTORY_BYTES = 48 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export type ChatRole = "user" | "assistant";

/** A response-local citation resolved from the server's actual evidence map. */
export interface ChatCitation {
  label: `[S${number}]`;
  documentId: string;
  chunkId: string;
  /** Display filename only, never a private path or a constructed URL. */
  sourceName: string;
  pageNumber: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  citations?: ChatCitation[];
}

export type TurnStatus = "pending" | "complete" | "failed" | "interrupted";

export interface ChatTurn {
  id: string;
  user: ChatMessage;
  assistant?: ChatMessage;
  status: TurnStatus;
}

export interface Conversation {
  version: 1;
  id: string;
  ownerId: string;
  turns: ChatTurn[];
}

export interface ChatRequest {
  message: string;
  messageId?: string;
  conversationId?: string;
  history?: ChatMessage[];
}
