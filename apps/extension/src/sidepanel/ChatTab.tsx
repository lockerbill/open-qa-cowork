import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../shared/messages.js';
import { sendChatMessage, type ChatMessage } from './backend.js';
import { renderMarkdownInline } from './preview.js';

/**
 * Free-form, multi-turn chat with the configured LLM. Ephemeral: history lives
 * in component state and is lost when the panel closes. Non-streaming: a
 * "thinking…" bubble shows while the full reply is awaited.
 */
export function ChatTab({ settings }: { settings: Settings | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message / the thinking indicator.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, busy]);

  if (!settings) return <p className="muted">Loading settings…</p>;

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;

    const history: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setErr('');
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { content } = await sendChatMessage(settings.backendUrl, history, controller.signal);
      setMessages([...history, { role: 'assistant', content }]);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // User pressed Stop — drop the pending turn and restore their draft.
        setMessages(messages);
        setInput(text);
      } else {
        setErr((e as Error).message);
        // Keep the user turn on screen but let them retry by restoring the draft.
        setInput(text);
        setMessages(messages);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
    setErr('');
  };

  const copy = async (index: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((i) => (i === index ? null : i)), 2000);
    } catch {
      setErr('Copy to clipboard failed');
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="chat">
      <div className="chat-toolbar row">
        <button className="ghost" onClick={newChat} disabled={messages.length === 0 && !busy}>
          New chat
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          {messages.length} message{messages.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !busy && (
          <p className="muted chat-empty">
            Ask the model anything. Conversation clears when you close the panel.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? (
              <>
                <div
                  className="msg-body markdown"
                  // Sanitized with DOMPurify in renderMarkdownInline.
                  dangerouslySetInnerHTML={{ __html: renderMarkdownInline(m.content) }}
                />
                <button className="msg-copy" onClick={() => copy(i, m.content)}>
                  {copiedIndex === i ? 'Copied' : 'Copy'}
                </button>
              </>
            ) : (
              <div className="msg-body">{m.content}</div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            <div className="msg-body muted">Thinking…</div>
          </div>
        )}
      </div>

      {err && <p className="err">{err}</p>}

      <div className="chat-composer">
        <textarea
          rows={2}
          placeholder="Message the model…  (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="ghost" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
