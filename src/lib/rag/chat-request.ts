import { z } from "zod";
import { ChatContextError, parseChatRequest } from "../../../app/lib/chat-context/context.ts";
import type { ChatRequest } from "../../../app/lib/chat-context/types.ts";

export const MAX_QUESTION_CHARACTERS = 4_000;
// Leave room for the existing client's bounded conversation metadata.
export const MAX_CHAT_REQUEST_BYTES = 512 * 1024;

export const chatQuerySchema = z.object(
  {
    question: z
      .string({ error: "Question must be a string" })
      .trim()
      .min(1, "Question must not be empty")
      .max(
        MAX_QUESTION_CHARACTERS,
        `Question must contain at most ${MAX_QUESTION_CHARACTERS} characters`,
      ),
  },
  { error: "A JSON object containing a question is required" },
);

export type ChatQueryRequest = z.infer<typeof chatQuerySchema> &
  Pick<ChatRequest, "history" | "messageId" | "conversationId">;

export type ChatQueryErrorCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "REQUEST_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_REQUEST";

export class ChatQueryError extends Error {
  readonly status: number;
  readonly code: ChatQueryErrorCode;
  readonly details?: { field: string; message: string }[];

  constructor(
    message: string,
    status: number,
    code: ChatQueryErrorCode,
    details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = "ChatQueryError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readChatQuery(request: Request): Promise<ChatQueryRequest> {
  request.signal.throwIfAborted();
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ChatQueryError(
      "Content-Type must be application/json",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_CHAT_REQUEST_BYTES) {
    throw new ChatQueryError("The chat request is too large", 413, "REQUEST_TOO_LARGE");
  }
  if (!request.body) {
    throw new ChatQueryError("A JSON request body is required", 400, "INVALID_JSON");
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
      if (receivedBytes > MAX_CHAT_REQUEST_BYTES) {
        throw new ChatQueryError("The chat request is too large", 413, "REQUEST_TOO_LARGE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (request.signal.aborted || error instanceof ChatQueryError) throw error;
    throw new ChatQueryError("The JSON request body could not be read", 400, "INVALID_JSON");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChatQueryError("The request body must contain valid JSON", 400, "INVALID_JSON");
  }

  // Provider settings remain server-owned; only the question and validated
  // conversation metadata are accepted from the caller.
  const parsed = chatQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new ChatQueryError(
      "The request must include a non-empty question of at most 4000 characters",
      400,
      "INVALID_REQUEST",
      parsed.error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.join(".") : "body",
        message: issue.message,
      })),
    );
  }
  const metadata = value as Record<string, unknown>;
  try {
    const context = parseChatRequest({
      message: parsed.data.question,
      history: metadata.history,
      messageId: metadata.messageId,
      conversationId: metadata.conversationId,
    });
    return {
      ...parsed.data,
      ...(metadata.history !== undefined ? { history: context.history } : {}),
      ...(context.messageId !== undefined ? { messageId: context.messageId } : {}),
      ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
    };
  } catch (error) {
    if (error instanceof ChatContextError) {
      throw new ChatQueryError(error.message, error.status, "INVALID_REQUEST");
    }
    throw error;
  }
}
