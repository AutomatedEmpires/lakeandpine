"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "bot" | "user"; text: string };

const STARTERS = [
  "What service is right for me?",
  "How much does a deep clean cost?",
  "Do you clean homes with pets?",
];

export function ChatDock() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "bot",
      text: "Ask what clean you need, what affects price, whether we bring supplies, or how soon you can schedule.",
    },
  ]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, open]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    try {
      const res = await fetch("/api/concierge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = (await res.json()) as { reply?: string };
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text:
            data.reply ??
            "I hit a snag — the fastest path is the estimate studio on the home page or the booking flow.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text: "I hit a snag — the fastest path is the estimate studio on the home page or the booking flow.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-dock">
      <div className={`chat-panel${open ? " open" : ""}`}>
        <div className="chat-head">
          <strong>🤖 Pine Concierge</strong>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close chat">
            ×
          </button>
        </div>
        <div className="chat-body" ref={bodyRef}>
          {messages.map((msg, i) => (
            <div key={i} className={`msg ${msg.role}`}>
              {msg.text}
            </div>
          ))}
          {messages.length === 1 &&
            STARTERS.map((prompt) => (
              <button key={prompt} className="btn btn-soft" onClick={() => send(prompt)}>
                {prompt}
              </button>
            ))}
        </div>
        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about cleaning..."
            aria-label="Message Pine Concierge"
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Send
          </button>
        </form>
      </div>
      <button
        className="chat-button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open Pine Concierge"
      >
        🤖
      </button>
    </div>
  );
}
