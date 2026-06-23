/**
 * Chat steer — inject a redirection message into an already-running chat
 * without cancelling it. The server's tool-loop drains the queue at the
 * top of each iteration and prepends the steer as a user-role message,
 * so the model sees it on its very next turn.
 *
 * The "Steer" button lives next to "Stop" in the processing indicator
 * and is only active while a job is processing. Clicking it opens a
 * small inline prompt; pressing Enter posts the steer, Escape cancels.
 */

import { API_BASE, currentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";

function showSteerPrompt(onSubmit) {
  const indicator = document.getElementById("processingIndicator");
  if (!indicator) return;
  // Remove any prior prompt
  indicator.querySelectorAll(".steer-prompt").forEach((n) => n.remove());

  const wrap = document.createElement("div");
  wrap.className = "steer-prompt";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 2000;
  input.placeholder = "Steer message (Enter to send, Esc to cancel)";
  input.className = "steer-input";
  const send = document.createElement("button");
  send.type = "button";
  send.textContent = "Send";
  send.className = "steer-send";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.className = "steer-cancel";

  const close = () => wrap.remove();
  const submit = () => {
    const text = input.value.trim();
    if (!text) return close();
    onSubmit(text);
    close();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  send.addEventListener("click", submit);
  cancel.addEventListener("click", close);

  wrap.appendChild(input);
  wrap.appendChild(send);
  wrap.appendChild(cancel);
  indicator.appendChild(wrap);
  input.focus();
}

async function sendSteer(text) {
  if (!currentSessionId) {
    alert("No active session.");
    return;
  }
  try {
    const res = await fetch(
      `${API_BASE}/chat/sessions/${encodeURIComponent(currentSessionId)}/steer`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: text }),
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
      alert(`Steer failed: ${detail}`);
      return;
    }
    const body = await res.json();
    const status = document.getElementById("processingStatusText");
    if (status) {
      const prior = status.textContent;
      status.textContent = `Steering applied (queue depth: ${body.queueDepth}). Next iteration will see it.`;
      setTimeout(() => {
        if (status.textContent.startsWith("Steering applied")) status.textContent = prior;
      }, 4000);
    }
  } catch (err) {
    alert(`Steer error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function installSteerButton() {
  const btn = document.getElementById("steerBtn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    showSteerPrompt(sendSteer);
  });
}

// Exposed for testing
export const __test = { sendSteer };
