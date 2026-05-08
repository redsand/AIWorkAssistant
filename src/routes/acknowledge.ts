import { FastifyInstance } from "fastify";
import { notificationStore } from "../push/notification-store";

export async function acknowledgeRoutes(server: FastifyInstance) {
  // Single acknowledge endpoint — ?source=hawk-ir&id=123 or ?source=jitbit&id=456
  server.get<{
    Querystring: { source: string; id: string };
  }>("/acknowledge", async (request, reply) => {
    const { source, id } = request.query;
    if (!source || !id) {
      return reply.code(400).type("text/html").send(acknowledgePage("", "", "Missing source or id parameter"));
    }
    return reply.type("text/html").send(acknowledgePage(source, id));
  });

  // API: check acknowledge status (requires auth)
  server.get<{
    Querystring: { source: string; sourceId: string };
  }>("/api/acknowledge-status", async (request) => {
    const { source, sourceId } = request.query;
    const notified = await notificationStore.hasBeenNotified(source, sourceId);
    if (!notified) {
      return { found: false, acknowledged: false };
    }
    const items = await notificationStore.getUnacknowledgedPastThreshold(0);
    const item = items.find((i) => i.source === source && i.externalId === sourceId);
    if (item && item.acknowledgedAt) {
      return { found: true, acknowledged: true, acknowledgedAt: item.acknowledgedAt };
    }
    return { found: true, acknowledged: false };
  });
}

function acknowledgePage(source: string, externalId: string, error?: string): string {
  if (error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#1e293b;border-radius:12px;padding:32px;max-width:420px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.4)}
.error{color:#fca5a5;font-size:14px}</style></head><body><div class="card"><p class="error">${error}</p></div></body></html>`;
  }

  const sourceLabel = source === "hawk-ir" ? "HAWK IR Case" : "Support Ticket";
  const icon = source === "hawk-ir" ? "&#x1F6A8;" : "&#x1F4E9;";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Acknowledge - ${sourceLabel} ${externalId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 32px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #f1f5f9; }
    .id { font-size: 14px; color: #94a3b8; margin-bottom: 24px; font-family: monospace; }
    .status {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      font-weight: 500;
    }
    .status.pending { background: #7c2d12; color: #fed7aa; border: 1px solid #c2410c; }
    .status.acknowledged { background: #14532d; color: #bbf7d0; border: 1px solid #16a34a; }
    .status.error { background: #450a0a; color: #fca5a5; border: 1px solid #dc2626; }
    .status.auth { background: #1e3a5f; color: #93c5fd; border: 1px solid #3b82f6; }
    .btn {
      background: #3b82f6;
      color: #fff;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    .btn:hover { background: #2563eb; }
    .btn:disabled { background: #475569; cursor: not-allowed; }
    .btn.acknowledged-btn { background: #16a34a; }
    .timestamp { font-size: 12px; color: #64748b; margin-top: 16px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <div class="title">${sourceLabel} Alert</div>
    <div class="id">${externalId}</div>
    <div id="status" class="status pending">Checking status...</div>
    <button id="ackBtn" class="btn hidden" onclick="acknowledge()">Acknowledge</button>
    <div id="timestamp" class="timestamp hidden"></div>
  </div>

  <script>
    const source = "${source}";
    const sourceId = "${externalId}";

    function getToken() {
      return localStorage.getItem('authToken');
    }

    const statusEl = document.getElementById('status');
    const ackBtn = document.getElementById('ackBtn');
    const tsEl = document.getElementById('timestamp');

    function requireAuth() {
      const token = getToken();
      if (!token) {
        statusEl.className = 'status auth';
        statusEl.textContent = 'Sign in required to acknowledge';
        ackBtn.textContent = 'Sign In';
        ackBtn.classList.remove('hidden');
        ackBtn.onclick = function() {
          const returnUrl = encodeURIComponent(window.location.href);
          window.location.href = '/?redirect=' + returnUrl;
        };
        return false;
      }
      return true;
    }

    async function checkStatus() {
      if (!requireAuth()) return;

      const token = getToken();
      const headers = { 'Authorization': 'Bearer ' + token };

      try {
        const res = await fetch('/api/acknowledge-status?source=' + encodeURIComponent(source) + '&sourceId=' + encodeURIComponent(sourceId), { headers });

        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem('authToken');
          requireAuth();
          return;
        }

        const data = await res.json();

        if (data.acknowledged) {
          statusEl.className = 'status acknowledged';
          statusEl.textContent = 'Already acknowledged';
          tsEl.textContent = 'Acknowledged at: ' + new Date(data.acknowledgedAt).toLocaleString();
          tsEl.classList.remove('hidden');
          ackBtn.classList.add('hidden');
        } else if (data.found) {
          statusEl.className = 'status pending';
          statusEl.textContent = 'Alert active — awaiting acknowledgement';
          ackBtn.classList.remove('hidden');
        } else {
          statusEl.className = 'status pending';
          statusEl.textContent = 'Alert may have expired — you can still acknowledge';
          ackBtn.classList.remove('hidden');
        }
      } catch (err) {
        statusEl.className = 'status pending';
        statusEl.textContent = 'Unable to check status — tap Acknowledge to confirm';
        ackBtn.classList.remove('hidden');
      }
    }

    async function acknowledge() {
      if (!requireAuth()) return;

      ackBtn.disabled = true;
      ackBtn.textContent = 'Acknowledging...';

      const token = getToken();
      const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

      try {
        const res = await fetch('/api/push-acknowledge', {
          method: 'POST',
          headers,
          body: JSON.stringify({ source, sourceId }),
        });

        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem('authToken');
          requireAuth();
          return;
        }

        const data = await res.json();

        if (res.ok && data.acknowledged) {
          statusEl.className = 'status acknowledged';
          statusEl.textContent = 'Acknowledged';
          tsEl.textContent = 'Acknowledged at: ' + new Date(data.timestamp).toLocaleString();
          tsEl.classList.remove('hidden');
          ackBtn.textContent = 'Acknowledged';
          ackBtn.className = 'btn acknowledged-btn';
          ackBtn.disabled = true;
        } else {
          statusEl.className = 'status error';
          statusEl.textContent = 'Error: ' + (data.error || 'Failed to acknowledge');
          ackBtn.disabled = false;
          ackBtn.textContent = 'Retry';
          ackBtn.onclick = acknowledge;
        }
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = 'Network error — please try again';
        ackBtn.disabled = false;
        ackBtn.textContent = 'Retry';
        ackBtn.onclick = acknowledge;
      }
    }

    checkStatus();
  </script>
</body>
</html>`;
}