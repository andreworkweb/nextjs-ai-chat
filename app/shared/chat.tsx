"use client";

import { useEffect, useRef } from "react";
import { useChat } from "../lib/chat-context/use-chat";
import { documentPath, resolveCitations } from "../lib/chat-context/citations";

function ChatIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" />
    </svg>
  );
}

export default function Chat() {
  const {
    message, setMessage, reply, loading, ready, error, conversation, askAI,
    clearConversation, documentAvailability,
  } = useChat();
  const threadRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followLatestRef = useRef(true);
  const turns = conversation?.turns ?? [];

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [message]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread && followLatestRef.current) {
      thread.scrollTop = thread.scrollHeight;
    }
  }, [conversation, reply, error, message]);

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#111111] font-sans text-[#ececec]">
      <header className="shrink-0 px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <ChatIcon />
            <h1 className="text-base font-semibold tracking-tight">Chat AI</h1>
          </div>
          <button
            type="button"
            title="Clear history and start a new conversation"
            aria-label="Clear history and start a new conversation"
            disabled={!ready}
            onClick={() => {
              followLatestRef.current = true;
              clearConversation();
              inputRef.current?.focus();
            }}
            className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm text-[#b4b4b4] transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a3a3a3] disabled:opacity-50"
          >
            <span aria-hidden="true" className="text-lg leading-none">+</span>
            New chat
          </button>
        </div>
      </header>

      <section
        ref={threadRef}
        aria-label="Conversation"
        tabIndex={0}
        onScroll={(event) => {
          const thread = event.currentTarget;
          followLatestRef.current =
            thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 [scrollbar-color:#454545_transparent] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#737373] sm:px-6"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col py-6 sm:py-8">
          {turns.length === 0 ? (
            <div className="my-auto flex flex-col items-center px-4 py-12 text-center">
              <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-white/5 text-[#d4d4d4]">
                <ChatIcon className="size-7" />
              </div>
              <h2 className="text-2xl font-medium tracking-tight sm:text-3xl">
                What can I help with?
              </h2>
              <p role="status" className="mt-3 text-sm leading-6 text-[#a3a3a3]">
                {ready ? "Send a message to start a conversation." : "Loading your conversation…"}
              </p>
            </div>
          ) : (
            <ol
              role="log"
              aria-label="Conversation messages"
              aria-live="polite"
              aria-relevant="additions text"
              aria-busy={loading}
              className="flex flex-col gap-8"
            >
              {turns.flatMap((turn, index) => {
                const isStreaming = loading && turn.status === "pending"
                  && index === turns.length - 1;
                const answer = turn.assistant?.content ?? (isStreaming ? reply : "");
                const citations = resolveCitations(answer, turn.assistant?.citations);

                return [
                  <li key={turn.user.id} className="flex justify-end">
                    <div className="relative max-w-[88%] rounded-3xl rounded-br-lg bg-[#303030] px-5 py-3 text-[15px] leading-7 sm:max-w-[80%]">
                      <span className="sr-only">You: </span>
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.user.content}</p>
                    </div>
                  </li>,
                  <li key={`${turn.id}:assistant`} className="flex min-w-0 gap-3 sm:gap-4">
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-white/10 text-[#d4d4d4]">
                      <ChatIcon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="mb-2 text-sm font-medium text-[#d4d4d4]">Chat AI</p>
                      {answer ? (
                        <p className="whitespace-pre-wrap text-[15px] leading-7 [overflow-wrap:anywhere]">
                          {answer}
                        </p>
                      ) : (
                        <p className="text-sm leading-7 text-[#a3a3a3]">
                          {isStreaming ? (
                            <span className="motion-safe:animate-pulse">Thinking…</span>
                          ) : turn.status === "pending" ? (
                            "Waiting for a response…"
                          ) : turn.status === "complete" ? (
                            "No response to display."
                          ) : (
                            "Response interrupted. Send your message again to retry."
                          )}
                        </p>
                      )}
                      {citations.length > 0 && (
                        <div className="mt-3 border-t border-white/10 pt-3 text-xs leading-5 text-[#a3a3a3]">
                          <p className="mb-1 font-medium text-[#b4b4b4]">Sources</p>
                          <ul aria-label="Sources for this answer" className="space-y-1">
                            {citations.map((citation) => {
                              const file = documentAvailability?.[citation.documentId] ? documentPath(citation.documentId) : undefined;
                              const label = <><span className="font-medium">{citation.label}</span>{" "}
                                {citation.sourceName} · Page {citation.pageNumber}</>;
                              return (
                                <li key={citation.label} className="[overflow-wrap:anywhere]">
                                  {file ? (
                                    <a href={`${file}#page=${citation.pageNumber}`} target="_blank" rel="noopener noreferrer"
                                      className="underline decoration-white/30 underline-offset-2 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
                                      aria-label={`Open ${citation.sourceName}, page ${citation.pageNumber} (new tab)`}>
                                      {label}
                                    </a>
                                  ) : label}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  </li>,
                ];
              })}
            </ol>
          )}
          {error && (
            <p role="alert" className="mt-6 text-sm leading-6 text-red-300">
              {error}
            </p>
          )}
        </div>
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          followLatestRef.current = true;
          void askAI();
        }}
        className="shrink-0 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6"
      >
        <div className="relative mx-auto flex w-full max-w-3xl items-end gap-3 rounded-3xl border border-[#3b3b3b] bg-[#262626] p-2 pl-5 transition-colors focus-within:border-[#737373]">
          <label htmlFor="chat-message" className="sr-only">
            Message
          </label>
          <textarea
            ref={inputRef}
            id="chat-message"
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (ready && !loading && message.trim()) {
                  event.currentTarget.form?.requestSubmit();
                }
              }
            }}
            placeholder="Message Chat AI…"
            aria-describedby="composer-hint"
            className="max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 text-[#ececec] outline-none placeholder:text-[#a3a3a3]"
          />
          <button
            type="submit"
            disabled={!ready || loading || !message.trim()}
            aria-label={loading ? "Generating response" : "Send message"}
            title={loading ? "Generating response" : "Send message"}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#ececec] text-[#171717] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:bg-[#3b3b3b] disabled:text-[#a3a3a3]"
          >
            {loading ? (
              <span aria-hidden="true" className="size-2 rounded-full bg-current motion-safe:animate-pulse" />
            ) : (
              <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5m-6 6 6-6 6 6" />
              </svg>
            )}
          </button>
        </div>
        <p id="composer-hint" className="mx-auto mt-2.5 max-w-3xl text-center text-xs leading-5 text-[#a3a3a3]">
          Enter to send · Shift + Enter for a new line
        </p>
      </form>
    </main>
  );
}
