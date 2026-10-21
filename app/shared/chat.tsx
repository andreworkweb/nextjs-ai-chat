"use client";

import { useChat } from "../lib/chat-context/use-chat";
import Link from "next/link";

export default function Chat() {
  const {
    message, setMessage, reply, loading, ready, error, askAI, clearConversation,
  } = useChat();

  return (
    <main className="flex min-h-dvh flex-col bg-black text-white">
      <header className="border-b border-[#0f0f0f] px-4 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <Link
            href=''
            title="Clear history and start a new conversation"
            aria-label="Clear history and start a new conversation"
            onClick={(event) => {
              event.preventDefault();
              clearConversation();
            }}
          >
          <h1 className="text-md font-semibold">Chat AI</h1>
          </Link>
        </div>
      </header>

      <section
        aria-live="polite"
        className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10"
      >
        {reply && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {reply}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-400">
            {error}
          </p>
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void askAI();
        }}
        className="w-full px-4 pb-4 sm:px-6 sm:pb-6"
      >
        <div className="relative mx-auto w-full max-w-3xl">
          <label htmlFor="chat-message" className="sr-only">
            Message
          </label>
          <input
            id="chat-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask anything..."
            className="h-14 w-full rounded-xl border border-[#303030] bg-[#171717] py-3 pl-4 pr-28 text-sm text-white outline-none placeholder:text-[#777777] focus:border-[#505050]"
          />
          <button
            type="submit"
            disabled={!ready || loading || !message.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-[#292929] px-3 py-2 text-xs text-white transition-colors hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Generating..." : "Ask AI"}
          </button>
        </div>
      </form>
    </main>
  );
}
