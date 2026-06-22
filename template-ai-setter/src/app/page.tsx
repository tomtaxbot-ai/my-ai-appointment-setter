/**
 * TEST CHAT UI
 * ------------
 * Visit http://localhost:3000 (or your Vercel URL) to chat with your AI.
 *
 * This is a tool for YOU — used to train and debug the AI before going
 * live in real Instagram DMs.
 */

"use client";

import { useState, useEffect, useRef } from "react";

type Message = { role: "lead" | "ai"; content: string; ts: number };

export default function TestChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState("test-default");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "lead", content: text, ts: Date.now() }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });
      const data = await res.json();

      if (data.error) {
        setMessages((prev) => [
          ...prev,
          { role: "ai", content: `[ERROR] ${data.error}: ${data.details ?? ""}`, ts: Date.now() },
        ]);
      } else {
        // Render bubbles one at a time, with a delay between each, like real human texting.
        for (let i = 0; i < data.segments.length; i++) {
          const seg = data.segments[i] as string;
          if (i > 0) {
            // Delay = 1.5s base + 40ms per character (caps at 5s), like real typing speed
            const chars = seg.length;
            const delay = Math.min(1500 + chars * 40, 5000);
            await new Promise((resolve) => setTimeout(resolve, delay));
            setMessages((prev) => [...prev, { role: "ai", content: "__typing__", ts: Date.now() }]);
            await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1200)));
            setMessages((prev) => prev.filter((m) => m.content !== "__typing__"));
          }
          setMessages((prev) => [...prev, { role: "ai", content: seg, ts: Date.now() }]);
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "ai", content: `[NETWORK ERROR] ${String(err)}`, ts: Date.now() },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function reset() {
    await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, reset: true }),
    });
    setMessages([]);
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>AI Setter — Test Chat</div>
        <div style={styles.sessionRow}>
          <span style={styles.sessionLabel}>session:</span>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            style={styles.sessionInput}
          />
          <button onClick={reset} style={styles.resetBtn}>reset</button>
        </div>
      </div>

      <div style={styles.chat}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            <div>👋 you're chatting with the AI as if you were a lead.</div>
            <div style={styles.emptyHint}>
              type a message below to test how it responds. edit your training
              in Supabase (`clients.system_prompt`, `voice_samples`, `active_rules`)
              and try again.
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.bubble,
              ...(m.role === "lead" ? styles.leadBubble : styles.aiBubble),
            }}
          >
            {m.content === "__typing__" ? <span style={{ opacity: 0.5, fontStyle: "italic" }}>typing...</span> : m.content}
          </div>
        ))}
        {loading && <div style={styles.typing}>thinking…</div>}
        <div ref={endRef} />
      </div>

      <div style={styles.inputRow}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="type a message as if you were a lead..."
          style={styles.input}
          disabled={loading}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={styles.sendBtn}>
          send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 700,
    margin: "0 auto",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    background: "#0a0a0a",
    color: "#e8e8e8",
  },
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid #222",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 18, fontWeight: 600 },
  sessionRow: { display: "flex", gap: 8, alignItems: "center", fontSize: 13 },
  sessionLabel: { color: "#888" },
  sessionInput: {
    background: "#1a1a1a",
    border: "1px solid #333",
    color: "#e8e8e8",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 13,
    width: 140,
  },
  resetBtn: {
    background: "#2a1a1a",
    border: "1px solid #4a2a2a",
    color: "#e88",
    padding: "4px 10px",
    borderRadius: 4,
    fontSize: 12,
    cursor: "pointer",
  },
  chat: {
    flex: 1,
    overflowY: "auto",
    padding: 20,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  empty: {
    color: "#666",
    textAlign: "center",
    margin: "auto 0",
    padding: 20,
  },
  emptyHint: { fontSize: 13, marginTop: 12, color: "#555" },
  bubble: {
    padding: "10px 14px",
    borderRadius: 16,
    maxWidth: "75%",
    fontSize: 15,
    lineHeight: 1.4,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  leadBubble: {
    alignSelf: "flex-end",
    background: "#0066ff",
    color: "white",
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    alignSelf: "flex-start",
    background: "#1f1f1f",
    color: "#e8e8e8",
    borderBottomLeftRadius: 4,
  },
  typing: { color: "#666", fontSize: 13, fontStyle: "italic", padding: "4px 12px" },
  inputRow: {
    display: "flex",
    gap: 8,
    padding: 16,
    borderTop: "1px solid #222",
  },
  input: {
    flex: 1,
    background: "#1a1a1a",
    border: "1px solid #333",
    color: "#e8e8e8",
    padding: "10px 14px",
    borderRadius: 20,
    fontSize: 15,
    outline: "none",
  },
  sendBtn: {
    background: "#0066ff",
    border: "none",
    color: "white",
    padding: "10px 20px",
    borderRadius: 20,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
};
