/**
 * Embeddable compact Runners panel for kanban / dashboard pages.
 *
 * Usage:
 *   <link rel="stylesheet" href="/css/runners.css" />
 *   <script src="/js/runners-panel.js" defer></script>
 *   <section id="runners-mount"></section>
 *   <script>
 *     window.RunnersPanel.mount({
 *       container: document.getElementById("runners-mount"),
 *       repoFilter: "owner/repo",   // optional
 *       sourceFilter: "github",       // optional
 *       presetCreate: { repo: "owner/repo", source: "github" }, // optional
 *       title: "Runners for foo/bar",  // optional
 *     });
 *   </script>
 *
 * Mount returns a controller: { destroy(), refresh() }.
 *
 * The panel covers the most common day-to-day ops in place: start, pause,
 * stop, run-now, view logs (popout to /runners?logs=<id>). Create/edit/delete
 * navigate to the full /runners page with pre-filled query params so the
 * UI stays simple here while still being useful.
 */
(() => {
  const API = "/api/runners";

  // ─── Auth (matches kanban.js / dashboard.js convention) ─────────────────
  function getAuthHeaders() {
    const token = localStorage.getItem("authToken");
    return token ? { Authorization: "Bearer " + token } : {};
  }
  function withApiKey(url) {
    const token = localStorage.getItem("authToken");
    if (!token) return url;
    return url + (url.includes("?") ? "&" : "?") + "apiKey=" + encodeURIComponent(token);
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

  function mount(opts) {
    if (!opts?.container) throw new Error("RunnersPanel.mount needs { container }");
    const container = opts.container;
    const repoFilter = (opts.repoFilter || "").trim().toLowerCase();
    const sourceFilter = (opts.sourceFilter || "").trim().toLowerCase();
    const presetCreate = opts.presetCreate || null;
    const title = opts.title || "Auto Runners";

    container.classList.add("rn-panel");
    container.innerHTML = `
      <header class="rn-panel-head">
        <div class="rn-panel-title">
          <span class="rn-panel-name"></span>
          <span class="rn-panel-count" data-count></span>
        </div>
        <div class="rn-panel-actions">
          <button class="rn-btn rn-btn-primary" data-new="aicoder">+ Aicoder</button>
          <button class="rn-btn rn-btn-primary" data-new="reviewer">+ Reviewer</button>
          <a class="rn-btn" data-full>Manage all →</a>
        </div>
      </header>
      <ul class="rn-panel-list" data-list></ul>
      <div class="rn-panel-empty" data-empty>No runners configured${repoFilter ? ` for ${repoFilter}` : ""}.</div>
    `;
    container.querySelector(".rn-panel-name").textContent = title;
    container.querySelector("[data-full]").href = "/runners";

    const listEl = container.querySelector("[data-list]");
    const countEl = container.querySelector("[data-count]");
    const emptyEl = container.querySelector("[data-empty]");
    const runners = new Map();

    container.querySelectorAll("[data-new]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.getAttribute("data-new");
        navigateToCreate(kind);
      });
    });

    function navigateToCreate(kind) {
      const params = new URLSearchParams({ new: kind });
      if (presetCreate) {
        for (const [k, v] of Object.entries(presetCreate)) {
          if (v) params.set(k, v);
        }
      } else if (repoFilter) {
        params.set("repo", repoFilter);
      }
      window.location.href = `/runners?${params.toString()}`;
    }

    function matchesFilter(r) {
      if (repoFilter) {
        const rRepo = (r.repo || "").toLowerCase();
        const rOwner = (r.owner || "").toLowerCase();
        const composed = rOwner && rRepo ? `${rOwner}/${rRepo}` : rRepo;
        if (!rRepo && !rOwner) return false;
        if (composed !== repoFilter && rRepo !== repoFilter) return false;
      }
      if (sourceFilter && r.source !== sourceFilter) return false;
      return true;
    }

    function renderAll() {
      const visible = [...runners.values()].filter(matchesFilter)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      listEl.innerHTML = "";
      countEl.textContent = visible.length ? `(${visible.length})` : "";
      emptyEl.style.display = visible.length ? "none" : "";
      for (const r of visible) listEl.appendChild(renderRow(r));
    }

    function renderRow(r) {
      const li = document.createElement("li");
      li.className = "rn-panel-row";
      li.dataset.id = r.id;
      li.innerHTML = `
        <div class="rn-panel-row-main">
          <div class="rn-panel-row-line1">
            <span class="rn-status rn-status--${r.status}">
              <span class="rn-status-dot"></span>
              <span class="rn-status-text"></span>
            </span>
            <span class="rn-panel-row-name"></span>
            <span class="rn-badge rn-badge--${r.kind}">${r.kind}</span>
          </div>
          <div class="rn-panel-row-line2"></div>
          <div class="rn-panel-row-err" data-err style="display:none"></div>
        </div>
        <div class="rn-panel-row-actions"></div>
      `;
      li.querySelector(".rn-status-text").textContent = r.status;
      li.querySelector(".rn-panel-row-name").textContent = r.name;

      const scope = [
        r.source,
        [r.owner, r.repo].filter(Boolean).join("/"),
        r.label && `label=${r.label}`,
        r.sprint && `sprint=${r.sprint}`,
        r.targetIssue && `issue=${r.targetIssue}`,
      ].filter(Boolean).join(" · ");
      const cur = r.status === "running" && r.lastStartedAt
        ? ` · started ${new Date(r.lastStartedAt).toLocaleTimeString()}`
        : r.lastFinishedAt
          ? ` · last ${new Date(r.lastFinishedAt).toLocaleTimeString()}`
          : "";
      li.querySelector(".rn-panel-row-line2").textContent = `${scope} · ${r.agent}${r.model ? "·" + r.model : ""}${cur}`;

      if (r.lastError) {
        const err = li.querySelector("[data-err]");
        err.style.display = "";
        err.textContent = r.lastError;
      }

      const actions = li.querySelector(".rn-panel-row-actions");
      const btn = (label, action, primary = false) => {
        const b = document.createElement("button");
        b.className = "rn-btn" + (primary ? " rn-btn-primary" : "");
        b.textContent = label;
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api(`${API}/${r.id}/${action}`, { method: "POST" });
          } catch (e) {
            alert(`${action} failed: ${e.message}`);
          } finally {
            b.disabled = false;
          }
        };
        return b;
      };
      if (r.enabled) actions.appendChild(btn("Pause", "pause"));
      else actions.appendChild(btn("Start", "start", true));
      actions.appendChild(btn("Stop", "stop"));
      actions.appendChild(btn("Run now", "run-now"));

      const logs = document.createElement("a");
      logs.className = "rn-btn";
      logs.textContent = "Logs";
      logs.href = `/runners?logs=${r.id}`;
      logs.target = "_blank";
      logs.rel = "noopener";
      actions.appendChild(logs);

      const edit = document.createElement("a");
      edit.className = "rn-btn";
      edit.textContent = "Edit";
      edit.href = `/runners?edit=${r.id}`;
      actions.appendChild(edit);

      return li;
    }

    async function refresh() {
      try {
        const data = await api(API);
        runners.clear();
        for (const r of data.runners) runners.set(r.id, r);
        renderAll();
      } catch (err) {
        listEl.innerHTML = `<li class="rn-panel-row rn-panel-row--err">Failed to load runners: ${err.message}</li>`;
      }
    }

    const es = new EventSource(withApiKey(`${API}/events`));
    es.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === "runner.created" || evt.type === "runner.updated" || evt.type === "runner.status") {
          runners.set(evt.runner.id, evt.runner);
          renderAll();
        } else if (evt.type === "runner.deleted") {
          runners.delete(evt.runnerId);
          renderAll();
        }
      } catch {}
    };
    es.onerror = () => { /* browser will retry */ };

    refresh();

    return {
      refresh,
      destroy() {
        es.close();
        container.innerHTML = "";
        container.classList.remove("rn-panel");
      },
    };
  }

  window.RunnersPanel = { mount };
})();
