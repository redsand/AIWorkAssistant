/**
 * CRUD for saved provider endpoints (e.g. a LAN Ollama box).
 *
 * Today only Ollama benefits from this (it's the only API provider that's
 * commonly self-hosted), but the table and routes are provider-agnostic so a
 * future remote OpenAI-compatible gateway can drop in without a migration.
 *
 * Reads + writes require an authenticated user — these credentials hand out
 * spawn-time API keys to background runners, so we don't accept anonymous
 * writes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import axios from "axios";
import { agentRunDatabase } from "../agent-runs/database";
import type {
  ProviderHostCreateParams,
  ProviderHostUpdateParams,
} from "../agent-runs/types";

const VALID_PROVIDERS = new Set(["ollama"]); // expand as we add remoteable providers

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.userId) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  return true;
}

function validateUrl(url: string): string | null {
  if (!url) return "baseUrl is required";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "baseUrl must use http or https";
    }
  } catch {
    return "baseUrl is not a valid URL";
  }
  return null;
}

// Bounds picked to cover both fast local boxes and slow CPU-only inference:
// 5s minimum keeps a typo from silently disabling timeouts, 3600s (1h) is
// well past any realistic single-reply time even on a tiny CPU machine.
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 3600;

function validateTimeout(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return "timeoutSeconds must be an integer";
  }
  if (value < MIN_TIMEOUT_SECONDS || value > MAX_TIMEOUT_SECONDS) {
    return `timeoutSeconds must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}`;
  }
  return null;
}

function validateCreate(body: Partial<ProviderHostCreateParams>): string | null {
  if (!body.name || typeof body.name !== "string") return "name is required";
  if (!body.provider || !VALID_PROVIDERS.has(body.provider)) {
    return `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}`;
  }
  if (!body.baseUrl || typeof body.baseUrl !== "string") return "baseUrl is required";
  const urlErr = validateUrl(body.baseUrl);
  if (urlErr) return urlErr;
  const timeoutErr = validateTimeout(body.timeoutSeconds);
  if (timeoutErr) return timeoutErr;
  return null;
}

/**
 * Extract a model list from any Ollama-shaped response. Ollama's native
 * `/api/tags` returns `{ models: [{ name, model, ... }] }`; an OpenAI-shim
 * (`/v1/models`) returns `{ data: [{ id }] }`. We try the native shape first.
 */
function extractModels(data: unknown): string[] {
  const root = (data ?? {}) as Record<string, unknown>;
  const fromTags = Array.isArray(root.models)
    ? (root.models as Array<Record<string, unknown>>).map(
        (m) =>
          (m.name as string | undefined) ||
          (m.model as string | undefined) ||
          (m.id as string | undefined) ||
          "",
      )
    : [];
  if (fromTags.length) return fromTags.filter(Boolean).sort((a, b) => a.localeCompare(b));

  const fromData = Array.isArray(root.data)
    ? (root.data as Array<Record<string, unknown>>).map(
        (m) =>
          (m.id as string | undefined) ||
          (m.name as string | undefined) ||
          "",
      )
    : [];
  return fromData.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Probe a remote Ollama (or OpenAI-shim) endpoint and return the model list.
 * Tries `/api/tags` first (native), then `/v1/models` (shim) — exactly how
 * provider-settings.ts already probes the configured Ollama URL.
 *
 * `timeoutMs` defaults to 10s but callers should pass the host's saved
 * timeoutSeconds when available — a slow box on cold-start can take longer
 * than the default just to answer /api/tags.
 */
async function probeModels(
  baseUrl: string,
  apiKey: string | null,
  timeoutMs = 10000,
): Promise<string[]> {
  const trimmed = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await axios.get(`${trimmed}/api/tags`, { headers, timeout: timeoutMs });
    return extractModels(response.data);
  } catch {
    const response = await axios.get(`${trimmed}/v1/models`, { headers, timeout: timeoutMs });
    return extractModels(response.data);
  }
}

export async function providerHostRoutes(fastify: FastifyInstance) {
  // ─── List ────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { provider?: string } }>(
    "/provider-hosts",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const provider = (request.query.provider || "").trim() || undefined;
      return { hosts: agentRunDatabase.listProviderHosts({ provider }) };
    },
  );

  // ─── Get one ─────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    "/provider-hosts/:id",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const host = agentRunDatabase.getProviderHost(request.params.id);
      if (!host) return reply.code(404).send({ error: "Host not found" });
      return host;
    },
  );

  // ─── Create ──────────────────────────────────────────────────────────────
  fastify.post("/provider-hosts", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as Partial<ProviderHostCreateParams>;
    const err = validateCreate(body);
    if (err) return reply.code(400).send({ error: err });
    // Soft-uniqueness: refuse a second row with the same (provider, baseUrl).
    // Same name is fine (someone might re-add their workstation under
    // "laptop" and "desktop" pointing at the same ssh-tunneled URL) but
    // (provider, baseUrl) collisions are always accidental double-saves.
    const baseUrlNorm = (body.baseUrl || "").trim().replace(/\/$/, "");
    const existing = agentRunDatabase
      .listProviderHosts({ provider: body.provider })
      .find((h) => h.baseUrl.replace(/\/$/, "") === baseUrlNorm);
    if (existing) {
      return reply.code(409).send({
        error: `A ${body.provider} host already points at ${baseUrlNorm} (id ${existing.id}, name "${existing.name}"). Edit that one instead.`,
      });
    }
    const host = agentRunDatabase.createProviderHost(body as ProviderHostCreateParams);
    return reply.code(201).send(host);
  });

  // ─── Update ──────────────────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>(
    "/provider-hosts/:id",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const body = (request.body ?? {}) as ProviderHostUpdateParams;
      if (body.provider && !VALID_PROVIDERS.has(body.provider)) {
        return reply.code(400).send({
          error: `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}`,
        });
      }
      if (body.baseUrl !== undefined) {
        const urlErr = validateUrl(body.baseUrl);
        if (urlErr) return reply.code(400).send({ error: urlErr });
      }
      if (body.timeoutSeconds !== undefined) {
        const timeoutErr = validateTimeout(body.timeoutSeconds);
        if (timeoutErr) return reply.code(400).send({ error: timeoutErr });
      }
      const updated = agentRunDatabase.updateProviderHost(request.params.id, body);
      if (!updated) return reply.code(404).send({ error: "Host not found" });
      return updated;
    },
  );

  // ─── Delete ──────────────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/provider-hosts/:id",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const ok = agentRunDatabase.deleteProviderHost(request.params.id);
      if (!ok) return reply.code(404).send({ error: "Host not found" });
      return { success: true };
    },
  );

  // ─── List models on a saved host ─────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    "/provider-hosts/:id/models",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const host = agentRunDatabase.getProviderHost(request.params.id);
      if (!host) return reply.code(404).send({ error: "Host not found" });
      try {
        const timeoutMs = host.timeoutSeconds ? host.timeoutSeconds * 1000 : 10000;
        const models = await probeModels(host.baseUrl, host.apiKey, timeoutMs);
        return { models, host: { id: host.id, name: host.name, provider: host.provider } };
      } catch (err) {
        return reply.code(502).send({
          error: "Failed to query host",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ─── Pull a model onto a saved host (streaming progress) ────────────────
  // Streams Ollama's POST /api/pull progress back to the browser as SSE.
  // The pull can take an hour for large models — we don't impose any axios
  // timeout (it runs on a stream connection that's only bounded by the
  // browser staying connected) and surface heartbeats so the user sees
  // download bytes ticking up.
  //
  // Body: { name: "model:tag" }
  // Events:
  //   data: { status, digest?, total?, completed?, error? }
  //   data: { type: "done" }  ← final event before the stream closes
  fastify.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/provider-hosts/:id/models/pull",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const host = agentRunDatabase.getProviderHost(request.params.id);
      if (!host) return reply.code(404).send({ error: "Host not found" });
      const name = (request.body?.name || "").trim();
      // Allow only the characters Ollama uses for model:tag references
      // (alnum, slash, colon, dot, dash, underscore). Stops shell-style
      // injection into the JSON payload we proxy upstream.
      if (!name || !/^[A-Za-z0-9:/_.-]+$/.test(name)) {
        return reply.code(400).send({
          error: "Invalid model name (allowed: alnum / : _ . - and /)",
        });
      }
      if (host.provider !== "ollama") {
        return reply.code(400).send({
          error: `Model pull not supported for provider '${host.provider}'`,
        });
      }

      const trimmed = host.baseUrl.replace(/\/$/, "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (host.apiKey) headers.Authorization = `Bearer ${host.apiKey}`;

      // Open SSE to client
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sse = (obj: unknown) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          // Client disconnected mid-write; ignore.
        }
      };

      // Heartbeats every 20s so proxies / browser don't kill the
      // connection during long byte-less phases (verify, write manifest).
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": ping\n\n");
        } catch {}
      }, 20000);

      // Cancellation: if the browser closes the tab, abort the upstream pull
      // so we don't leak the Ollama side either.
      //
      // We listen on reply.raw ("close" fires on response end OR client
      // disconnect) and gate on writableEnded — a normal end() also triggers
      // the close event, and we don't want to abort ourselves at that point.
      //
      // We do NOT listen on request.raw "close": for a POST that event fires
      // as soon as the body has been fully consumed, which for our tiny JSON
      // body happens within milliseconds. Listening there killed every pull
      // with axios "canceled" before the upstream even responded.
      const upstreamAbort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) {
          clearInterval(heartbeat);
          upstreamAbort.abort();
        }
      });

      try {
        // 60-minute axios timeout matches the user's request; Ollama's pull
        // for large models can run that long over a slow link.
        const upstream = await axios.post(
          `${trimmed}/api/pull`,
          { name, stream: true },
          {
            headers,
            responseType: "stream",
            timeout: 60 * 60 * 1000,
            signal: upstreamAbort.signal,
            // Ollama's pull never returns 4xx mid-stream — but if it does
            // (e.g. invalid model name), let us handle it ourselves.
            validateStatus: () => true,
          },
        );

        if (upstream.status >= 400) {
          // Drain the error body so we can report what Ollama said.
          const chunks: Buffer[] = [];
          for await (const c of upstream.data as AsyncIterable<Buffer>) {
            chunks.push(c);
          }
          const body = Buffer.concat(chunks).toString("utf8").slice(0, 2000);
          sse({ error: `Ollama returned ${upstream.status}: ${body}` });
          sse({ type: "done", success: false });
          clearInterval(heartbeat);
          reply.raw.end();
          return;
        }

        // Stream is ndjson — buffer partial lines.
        let buffer = "";
        for await (const chunk of upstream.data as AsyncIterable<Buffer>) {
          buffer += chunk.toString("utf8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            try {
              sse(JSON.parse(trimmedLine));
            } catch {
              // Non-JSON line — forward raw so debug is still useful
              sse({ raw: trimmedLine });
            }
          }
        }
        if (buffer.trim()) {
          try {
            sse(JSON.parse(buffer.trim()));
          } catch {
            sse({ raw: buffer.trim() });
          }
        }
        sse({ type: "done", success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sse({ error: message });
        sse({ type: "done", success: false });
      } finally {
        clearInterval(heartbeat);
        try {
          reply.raw.end();
        } catch {}
      }
    },
  );

  // ─── Delete a model from a saved host ────────────────────────────────────
  // Proxies to Ollama's `DELETE /api/delete` (body: { name }) so the user
  // can manage disk space on a remote box without leaving the chat UI.
  // No-op gracefully if the host's provider doesn't support deletion yet.
  fastify.delete<{ Params: { id: string; name: string } }>(
    "/provider-hosts/:id/models/:name",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const host = agentRunDatabase.getProviderHost(request.params.id);
      if (!host) return reply.code(404).send({ error: "Host not found" });
      const name = decodeURIComponent(request.params.name);
      if (!name) return reply.code(400).send({ error: "Model name required" });

      if (host.provider !== "ollama") {
        return reply.code(400).send({
          error: `Model delete not supported for provider '${host.provider}'`,
        });
      }

      const trimmed = host.baseUrl.replace(/\/$/, "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (host.apiKey) headers.Authorization = `Bearer ${host.apiKey}`;

      try {
        const timeoutMs = host.timeoutSeconds ? host.timeoutSeconds * 1000 : 30000;
        await axios.delete(`${trimmed}/api/delete`, {
          headers,
          data: { name },
          timeout: timeoutMs,
        });
        return { success: true, name };
      } catch (err: unknown) {
        // Ollama returns 404 when the model doesn't exist — surface that
        // distinctly so the UI can show "already gone" instead of a hard error.
        const status =
          err && typeof err === "object" && "response" in err
            ? (err as { response?: { status?: number } }).response?.status
            : undefined;
        if (status === 404) {
          return reply.code(404).send({
            error: `Model '${name}' not found on host`,
          });
        }
        return reply.code(502).send({
          error: "Failed to delete model",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ─── Probe an arbitrary URL (used by the Add-Host modal's Test button) ──
  fastify.post<{
    Body: {
      baseUrl?: string;
      apiKey?: string | null;
      provider?: string;
      timeoutSeconds?: number | null;
    };
  }>("/provider-hosts/probe", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = request.body ?? {};
    const provider = (body.provider || "").trim();
    if (!VALID_PROVIDERS.has(provider)) {
      return reply.code(400).send({
        error: `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}`,
      });
    }
    const urlErr = validateUrl(body.baseUrl || "");
    if (urlErr) return reply.code(400).send({ error: urlErr });
    const timeoutErr = validateTimeout(body.timeoutSeconds);
    if (timeoutErr) return reply.code(400).send({ error: timeoutErr });
    try {
      const timeoutMs = body.timeoutSeconds ? body.timeoutSeconds * 1000 : 10000;
      const models = await probeModels(body.baseUrl!, body.apiKey ?? null, timeoutMs);
      return { ok: true, models };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
