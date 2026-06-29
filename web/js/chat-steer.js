/**
 * Chat steer — inject a redirection message into an already-running chat
 * without cancelling it. The server's tool-loop drains the queue at the
 * top of each iteration and prepends the steer as a user-role message,
 * so the model sees it on its very next turn.
 *
 * The user composes the steer in the main chat input. When a request is
 * in flight, sendMessage() in chat.js routes through sendSteer() here
 * instead of starting a fresh POST. We render the steer optimistically
 * in the chat panel so the user sees their interjection immediately;
 * the server-side POST persists the same text to conversationManager so
 * it survives a page refresh even if the tool loop ends before draining
 * the queue.
 */

import { API_BASE, currentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, scrollChatToBottom } from "./messages.js";

/**
 * Send a steer for the active session. The chat.js send path calls this
 * when activeStreamController is non-null (i.e. a job is in flight).
 *
 * Returns { ok: true } on success, { ok: false, status, error } on
 * failure so the caller can decide whether to fall back to a fresh
 * send. Caller is responsible for clearing the textarea.
 */
export async function sendSteer(text) {
  if (!currentSessionId) {
    return { ok: false, status: 0, error: "No active session" };
  }
  const trimmed = (text || "").trim();
  if (!trimmed) return { ok: false, status: 0, error: "Empty steer" };

  // Optimistically render the user message immediately so the user sees
  // their interjection without waiting for the server round-trip. The
  // server persists the same text on POST, so on refresh it'll come
  // back from conversationManager identically — no double render.
  addMessage(trimmed, "user");
  scrollChatToBottom();

  // Status pill update so the user has a visible cue that the steer
  // landed and is queued.
  const status = document.getElementById("processingStatusText");
  const priorStatus = status?.textContent;

  try {
    const res = await fetch(
      `${API_BASE}/chat/sessions/${encodeURIComponent(currentSessionId)}/steer`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: trimmed }),
      },
    );
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        detail = body.error || body.message || detail;
      } catch {
        /* */
      }
      // Roll the optimistic render back so the user doesn't see a
      // ghost message that the server never accepted.
      removeLastUserMessageIfMatches(trimmed);
      if (status) status.textContent = `Steer failed: ${detail}`;
      return { ok: false, status: res.status, error: detail };
    }
    const body = await res.json();
    if (status) {
      status.textContent = `Steering applied (queue depth: ${body.queueDepth}). Next iteration will see it.`;
      setTimeout(() => {
        if (status.textContent.startsWith("Steering applied")) {
          status.textContent = priorStatus || "Processing your request...";
        }
      }, 4000);
    }
    return { ok: true };
  } catch (err) {
    removeLastUserMessageIfMatches(trimmed);
    const msg = err instanceof Error ? err.message : String(err);
    if (status) status.textContent = `Steer error: ${msg}`;
    return { ok: false, status: 0, error: msg };
  }
}

/**
 * If the last rendered .message.user bubble is the one we just
 * optimistically appended, remove it. Used to roll back when the
 * server rejects the steer (no active run, validation error, etc.).
 * Safe no-op when the DOM moved on (e.g. the model already replied).
 */
function removeLastUserMessageIfMatches(text) {
  const messagesDiv = document.getElementById("chatMessages");
  if (!messagesDiv) return;
  const userMessages = messagesDiv.querySelectorAll(".message.user");
  const last = userMessages[userMessages.length - 1];
  if (!last) return;
  if (last.dataset.originalText === text || last.textContent.trim() === text) {
    last.remove();
  }
}

/**
 * Legacy installer for the dedicated Steer button that used to live
 * next to Stop in the processing indicator. The button still exists in
 * the DOM (hidden via CSS in this round) so old user docs don't break,
 * but the canonical interaction is now the main chat input: Send turns
 * into Steer while a job is processing. Wired here as a no-op so the
 * existing chat.js bootstrap call doesn't crash on missing exports.
 */
export function installSteerButton() {
  const btn = document.getElementById("steerBtn");
  if (btn) {
    // Hide the legacy button — the chat input handles steering now.
    btn.style.display = "none";
  }
}

// Exposed for testing
export const __test = { sendSteer, removeLastUserMessageIfMatches };
