"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "bot" | "user"; text: string };

const STARTERS = [
  "Which property program fits?",
  "How does a custom proposal work?",
  "What happens after a request?",
];

export function ChatDock() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "bot",
      text: "Ask which property program fits, what shapes a proposal, how timing is confirmed, or what happens after a request.",
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
            "I hit a snag — the fastest path is the consultation request or the service overview.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "bot",
          text: "I hit a snag — the fastest path is the consultation request or the service overview.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-dock">
      <div
        className={`chat-panel${open ? " open" : ""}`}
        id="pine-concierge-panel"
        aria-hidden={!open}
        inert={!open}
      >
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
        aria-label={open ? "Close Pine Concierge" : "Open Pine Concierge"}
        aria-expanded={open}
        aria-controls="pine-concierge-panel"
      >
        🤖
      </button>
    </div>
  );
}
