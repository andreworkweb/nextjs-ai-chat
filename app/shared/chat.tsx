"use client";

import { useState } from "react";

export default function Chat() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function askAI() {
    if (!message.trim() || loading) return;

    setLoading(true);
    setError("");
    setReply("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: message,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate response");
      }

      const data = await response.json();

      setReply(data.answer);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>AI Chat</h1>

      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Ask anything..."
      />

      <button
        onClick={askAI}
        disabled={loading || !message.trim()}
      >
        {loading ? "Generating..." : "Ask AI"}
      </button>

      <p style={{ whiteSpace: "pre-wrap" }}>{reply}</p>

      {error && <p role="alert">{error}</p>}
    </main>
  );
}
