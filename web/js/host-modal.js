/**
 * Reusable Add/Edit Provider Host modal.
 *
 * Mounts a self-contained modal into <body> on first use. Any page that needs
 * CRUD on saved provider hosts (today: /runners and the chat header) can call
 * HostModal.open({...}) and get the same UI + behavior.
 *
 * For saved hosts the modal also shows the model catalog with per-row delete
 * buttons — handy for cleaning out a remote Ollama box without leaving the
 * chat. Add-mode hides the catalog (no id yet to delete against).
 *
 * Convention: the modal expects an existing auth token in localStorage under
 * "authToken" (matches kanban.js / runners.js).
 */
(() => {
  let mounted = false;
  let activeOpts = null;
  let currentSavedHostId = null; // null while in add-mode, host id while editing

  const REMOTEABLE_PROVIDERS = ["ollama"];

  function getAuthHeaders() {
    const token = localStorage.getItem("authToken");
    return token ? { Authorization: "Bearer " + token } : {};
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      ...opts,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function ensureMounted() {
    if (mounted) return;
    mounted = true;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="hm-modal" id="hm-host-modal" hidden>
        <div class="hm-modal-backdrop" data-hm-close></div>
        <div class="hm-modal-body">
          <header class="hm-modal-header">
            <h2 id="hm-title">Add provider host</h2>
            <button class="hm-modal-close" data-hm-close>&times;</button>
          </header>
          <div class="hm-modal-content">
            <form id="hm-form" class="hm-form">
              <input type="hidden" name="id" />

              <label>
                <span>Provider</span>
                <select name="provider">
                  ${REMOTEABLE_PROVIDERS.map(
                    (p) => `<option value="${p}">${p}</option>`,
                  ).join("")}
                </select>
              </label>

              <label>
                <span>Name</span>
                <input name="name" required placeholder="e.g. Zotac 4060 Ti box" />
              </label>

              <label>
                <span>Base URL</span>
                <input name="baseUrl" required placeholder="http://192.168.1.50:11434" />
              </label>

              <label>
                <span>API key (optional)</span>
                <input name="apiKey" type="password" autocomplete="off" placeholder="leave blank for unauthenticated" />
              </label>

              <label>
                <span>
                  Request timeout (seconds, optional)
                  <small style="color:#888;font-weight:400">
                    — applies to total request + first-token wait
                  </small>
                </span>
                <input name="timeoutSeconds" type="number" min="5" max="3600" step="5" placeholder="default: 300 total / 30 first-token" />
              </label>

              <label>
                <span>Notes (optional)</span>
                <input name="notes" placeholder="e.g. 16GB VRAM, runs llama3:70b-q4_K_M" />
              </label>

              <div id="hm-test-result" class="hm-test-result" hidden></div>
            </form>

            <section class="hm-models" id="hm-models-section" hidden>
              <header class="hm-models-head">
                <h3>Models on this host</h3>
                <button type="button" class="hm-btn hm-btn-mini" id="hm-models-refresh">Refresh</button>
              </header>

              <!-- Pull a new model. Server side proxies to Ollama's
                   /api/pull with a 60-min ceiling and streams progress
                   back as SSE so the user sees download bytes ticking. -->
              <div class="hm-pull-row">
                <input
                  type="text"
                  class="hm-pull-input"
                  id="hm-pull-input"
                  placeholder="model:tag (e.g. qwen2.5-coder:14b-instruct-q4_K_M)"
                  spellcheck="false"
                  autocomplete="off"
                />
                <button type="button" class="hm-btn hm-btn-primary hm-btn-mini" id="hm-pull-btn">
                  Pull
                </button>
              </div>
              <div class="hm-pull-progress" id="hm-pull-progress" hidden></div>

              <div class="hm-models-list" id="hm-models-list">
                <div class="hm-models-empty">Loading…</div>
              </div>
            </section>
          </div>

          <footer class="hm-modal-footer">
            <button type="button" class="hm-btn hm-btn-danger" id="hm-delete-btn" hidden>Delete host</button>
            <span style="flex: 1"></span>
            <button type="button" class="hm-btn" id="hm-test-btn">Test connection</button>
            <button type="button" class="hm-btn" data-hm-close>Cancel</button>
            <button type="button" class="hm-btn hm-btn-primary" id="hm-save-btn">Save</button>
          </footer>
        </div>
      </div>
    `;
    document.body.appendChild(wrapper.firstElementChild);

    document
      .querySelectorAll("#hm-host-modal [data-hm-close]")
      .forEach((el) => el.addEventListener("click", close));
    document.getElementById("hm-form").addEventListener("submit", submitForm);
    document.getElementById("hm-save-btn").addEventListener("click", () => {
      // Manual submit so the Save button outside the form still triggers it.
      document
        .getElementById("hm-form")
        .dispatchEvent(new Event("submit", { cancelable: true }));
    });
    document.getElementById("hm-test-btn").addEventListener("click", testConnection);
    document.getElementById("hm-delete-btn").addEventListener("click", deleteHost);
    document
      .getElementById("hm-models-refresh")
      .addEventListener("click", () => loadModelList({ force: true }));
    document
      .getElementById("hm-pull-btn")
      .addEventListener("click", pullModel);
    document
      .getElementById("hm-pull-input")
      .addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          pullModel();
        }
      });
  }

  function open(opts) {
    ensureMounted();
    activeOpts = opts || {};
    const host = activeOpts.host || null;
    const presetProvider = activeOpts.provider || (host && host.provider) || REMOTEABLE_PROVIDERS[0];
    const form = document.getElementById("hm-form");
    form.reset();
    document.getElementById("hm-test-result").hidden = true;
    document.getElementById("hm-models-section").hidden = true;
    document.getElementById("hm-pull-progress").hidden = true;
    document.getElementById("hm-pull-input").value = "";
    currentSavedHostId = null;

    if (host) {
      document.getElementById("hm-title").textContent = `Edit host: ${host.name}`;
      form.id.value = host.id;
      form.provider.value = host.provider;
      form.name.value = host.name;
      form.baseUrl.value = host.baseUrl;
      form.apiKey.value = host.apiKey || "";
      form.notes.value = host.notes || "";
      form.timeoutSeconds.value = host.timeoutSeconds || "";
      document.getElementById("hm-delete-btn").hidden = false;
      currentSavedHostId = host.id;
      // Saved host → fetch model catalog so the user can delete entries.
      loadModelList({ force: false });
    } else {
      document.getElementById("hm-title").textContent = "Add provider host";
      form.id.value = "";
      form.provider.value = REMOTEABLE_PROVIDERS.includes(presetProvider)
        ? presetProvider
        : REMOTEABLE_PROVIDERS[0];
      if (form.provider.value === "ollama") {
        form.baseUrl.value = "http://localhost:11434";
      }
      document.getElementById("hm-delete-btn").hidden = true;
    }
    document.getElementById("hm-host-modal").hidden = false;
    form.name.focus();
  }

  function close() {
    const modal = document.getElementById("hm-host-modal");
    if (modal) modal.hidden = true;
    // If a pull is mid-flight when the user dismisses the modal, abort it
    // so we don't leak the upstream Ollama connection or the SSE reader.
    if (pullAbort) {
      try {
        pullAbort.abort();
      } catch {}
      pullAbort = null;
    }
    activeOpts = null;
    currentSavedHostId = null;
  }

  async function submitForm(e) {
    e.preventDefault();
    const form = e.target;
    const timeoutRaw = form.timeoutSeconds.value.trim();
    const body = {
      name: form.name.value.trim(),
      provider: form.provider.value,
      baseUrl: form.baseUrl.value.trim(),
      apiKey: form.apiKey.value.trim() || null,
      notes: form.notes.value.trim() || null,
      timeoutSeconds: timeoutRaw === "" ? null : Number(timeoutRaw),
    };
    try {
      let saved;
      if (form.id.value) {
        saved = await api(`/api/provider-hosts/${form.id.value}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        saved = await api(`/api/provider-hosts`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      const opts = activeOpts;
      close();
      opts?.onSaved?.(saved);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  }

  async function testConnection() {
    const form = document.getElementById("hm-form");
    const result = document.getElementById("hm-test-result");
    result.hidden = false;
    result.className = "hm-test-result";
    result.textContent = "Testing…";
    try {
      const timeoutRaw = form.timeoutSeconds.value.trim();
      const data = await api(`/api/provider-hosts/probe`, {
        method: "POST",
        body: JSON.stringify({
          provider: form.provider.value,
          baseUrl: form.baseUrl.value.trim(),
          apiKey: form.apiKey.value.trim() || null,
          timeoutSeconds: timeoutRaw === "" ? null : Number(timeoutRaw),
        }),
      });
      result.className = "hm-test-result hm-test-result--ok";
      const n = data.models?.length || 0;
      result.textContent =
        n === 0
          ? "✓ Reached host, but no models installed."
          : `✓ Reached host. Found ${n} model${n === 1 ? "" : "s"}.`;
      // If we're editing a saved host, mirror the freshly-probed models into
      // the catalog so the user sees the just-loaded list with delete buttons.
      if (currentSavedHostId) {
        renderModelList(data.models || []);
        document.getElementById("hm-models-section").hidden = false;
      }
    } catch (err) {
      result.className = "hm-test-result hm-test-result--err";
      result.textContent = `✗ ${err.message}`;
    }
  }

  async function deleteHost() {
    const form = document.getElementById("hm-form");
    if (!form.id.value) return;
    if (
      !confirm(
        `Delete host "${form.name.value}"? Anything using it will revert to the server's env defaults.`,
      )
    ) {
      return;
    }
    try {
      await api(`/api/provider-hosts/${form.id.value}`, { method: "DELETE" });
      const deletedId = form.id.value;
      const opts = activeOpts;
      close();
      opts?.onDeleted?.(deletedId);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  // ─── Model catalog (for saved hosts only) ──────────────────────────────

  async function loadModelList({ force }) {
    if (!currentSavedHostId) return;
    const section = document.getElementById("hm-models-section");
    const list = document.getElementById("hm-models-list");
    section.hidden = false;
    list.innerHTML = '<div class="hm-models-empty">Loading…</div>';
    try {
      const url =
        `/api/provider-hosts/${currentSavedHostId}/models` +
        (force ? `?t=${Date.now()}` : "");
      const data = await api(url);
      renderModelList(data.models || []);
    } catch (err) {
      list.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "hm-models-empty hm-models-empty--err";
      empty.textContent = `Failed to load models: ${err.message}`;
      list.appendChild(empty);
    }
  }

  function renderModelList(models) {
    const list = document.getElementById("hm-models-list");
    list.innerHTML = "";
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "hm-models-empty";
      empty.textContent = "No models installed on this host.";
      list.appendChild(empty);
      return;
    }
    for (const name of models) {
      const row = document.createElement("div");
      row.className = "hm-model-row";
      const nameEl = document.createElement("span");
      nameEl.className = "hm-model-name";
      nameEl.textContent = name;
      row.appendChild(nameEl);
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "hm-btn hm-btn-mini hm-btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteModel(name, row));
      row.appendChild(delBtn);
      list.appendChild(row);
    }
  }

  async function deleteModel(name, rowEl) {
    if (!currentSavedHostId) return;
    if (!confirm(`Delete model "${name}" from this host? This frees disk space on the remote box.`)) {
      return;
    }
    const btn = rowEl.querySelector("button");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Deleting…";
    }
    try {
      await api(
        `/api/provider-hosts/${currentSavedHostId}/models/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      rowEl.remove();
      // If the list is now empty, replace with empty-state message.
      const list = document.getElementById("hm-models-list");
      if (!list.children.length) {
        const empty = document.createElement("div");
        empty.className = "hm-models-empty";
        empty.textContent = "No models installed on this host.";
        list.appendChild(empty);
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Delete";
      }
      alert(`Delete failed: ${err.message}`);
    }
  }

  // ─── Pull a new model from the registry onto this host ────────────────

  let pullAbort = null;

  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
  }

  function setPullProgress(html, kind) {
    const el = document.getElementById("hm-pull-progress");
    el.hidden = false;
    el.className = "hm-pull-progress" + (kind ? " hm-pull-progress--" + kind : "");
    el.innerHTML = html;
  }

  async function pullModel() {
    if (!currentSavedHostId) {
      alert("Save the host first before pulling models.");
      return;
    }
    const input = document.getElementById("hm-pull-input");
    const name = input.value.trim();
    if (!name) return;
    // Mirror the server's allow-list so we don't even bother on garbage
    if (!/^[A-Za-z0-9:/_.-]+$/.test(name)) {
      alert("Invalid model name (allowed: letters, digits, : / _ . -)");
      return;
    }
    if (pullAbort) {
      alert("A pull is already in progress.");
      return;
    }

    const btn = document.getElementById("hm-pull-btn");
    btn.disabled = true;
    btn.textContent = "Pulling…";
    input.disabled = true;
    setPullProgress(`Starting pull of <code>${name}</code>…`, null);

    pullAbort = new AbortController();
    const startedAt = Date.now();
    let lastDigest = null;
    let lastStatus = null;
    let success = false;
    let errorMessage = null;

    try {
      const res = await fetch(
        `/api/provider-hosts/${currentSavedHostId}/models/pull`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({ name }),
          signal: pullAbort.signal,
        },
      );
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read SSE frames. Frames are separated by "\n\n"; each frame may have
      // multiple `data: ...` lines per the SSE spec.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (!dataLine) continue;
          let event;
          try {
            event = JSON.parse(dataLine);
          } catch {
            continue;
          }
          if (event.type === "done") {
            success = !!event.success;
            continue;
          }
          if (event.error) {
            errorMessage = event.error;
            continue;
          }
          // Progress line from Ollama. Common shapes:
          //   { status: "pulling manifest" }
          //   { status: "downloading", digest, total, completed }
          //   { status: "verifying sha256 digest" }
          //   { status: "writing manifest" }
          //   { status: "success" }
          if (typeof event.status === "string") lastStatus = event.status;
          if (typeof event.digest === "string") lastDigest = event.digest;
          const total = event.total;
          const completed = event.completed;
          let line = `<strong>${escape(lastStatus || "working")}</strong>`;
          if (
            Number.isFinite(total) &&
            total > 0 &&
            Number.isFinite(completed)
          ) {
            const pct = ((completed / total) * 100).toFixed(1);
            line += ` — ${formatBytes(completed)} / ${formatBytes(total)} (${pct}%)`;
          }
          if (lastDigest) {
            line += `<br><small><code>${escape(lastDigest.slice(0, 26))}…</code></small>`;
          }
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          line += `<br><small>Elapsed: ${elapsed}s</small>`;
          setPullProgress(line, null);
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        errorMessage = "Cancelled";
      } else {
        errorMessage = err.message || String(err);
      }
    } finally {
      pullAbort = null;
      btn.disabled = false;
      btn.textContent = "Pull";
      input.disabled = false;
    }

    if (success && !errorMessage) {
      setPullProgress(
        `✓ Pulled <code>${escape(name)}</code> in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
        "ok",
      );
      input.value = "";
      // Refresh the catalog so the new model appears with a Delete button.
      loadModelList({ force: true });
    } else {
      setPullProgress(
        `✗ Pull failed: ${escape(errorMessage || "unknown error")}`,
        "err",
      );
    }
  }

  function escape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.HostModal = {
    open,
    close,
    REMOTEABLE_PROVIDERS,
    async list(provider) {
      const params = provider ? `?provider=${encodeURIComponent(provider)}` : "";
      const { hosts } = await api(`/api/provider-hosts${params}`);
      return hosts || [];
    },
  };
})();
