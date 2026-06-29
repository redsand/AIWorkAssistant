/* Auto Runners UI — vanilla JS, no framework. */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    runners: new Map(),
    logSource: null,
    eventSource: null,
    repoCombo: null,
    branchCombo: null,
    repoOptions: [],          // last-fetched RepoOption[] from server
    branchCache: new Map(),   // key = `${source}:${repoKey}` → string[]
    // Provider hosts (saved remote endpoints, today: ollama only)
    hosts: [],                // last-fetched ProviderHost[]
    hostCombo: null,          // combobox for the runner form's Host picker
    modelCombo: null,         // combobox for the runner form's Model picker
    modelCache: new Map(),    // key = hostId → string[] of model names
    // The runner id currently being edited, OR null when the modal is in
    // create mode. Previously the create-vs-update decision read from the
    // form's hidden `id` input, but any stray form.reset() or DOM
    // replacement silently wiped it — and a "save" on an edit then POSTed
    // a brand new runner instead of PATCHing the existing one. Tracking
    // it in a closure variable here makes the intent unkillable.
    editingRunnerId: null,
  };

  // Providers that expose a remote/self-host. Drives whether the Host
  // picker is shown when the runner's API provider <select> changes.
  const REMOTEABLE_PROVIDERS = new Set(["ollama"]);

  // Sources where the user MUST type the workspace clone URL because the
  // issue platform itself doesn't know where the code lives. For github /
  // gitlab the repo picker fills repoUrl + base branch from the platform
  // API automatically, so the field is just visual noise.
  const SOURCES_NEED_REPO_URL = new Set(["jira", "work_items", "jitbit", "auto"]);

  function updateRepoUrlVisibility(source) {
    const row = $("#repo-url-row");
    const reloadBtn = $("#reload-branches");
    const needs = SOURCES_NEED_REPO_URL.has(source);
    if (row) row.hidden = !needs;
    // The Reload button calls ls-remote on the manually-typed URL — only
    // useful for sources without a platform branch API.
    if (reloadBtn) reloadBtn.hidden = !needs;
  }

  /**
   * Show/hide form fields based on runner kind. Reviewer doesn't shell out
   * to a coding agent and doesn't pick issues by label/sprint — it works on
   * existing MRs/PRs. So we hide aicoder-only fields entirely and show the
   * reviewer-only row (workspace path + target MR).
   *
   * Also strips source options that reviewer can't handle (jira/work_items/
   * jitbit/auto have no MRs to review).
   */
  function updateKindFieldVisibility(kind) {
    const isReviewer = kind === "reviewer";
    // Toggle every element marked with data-kind to its opposite of current
    document
      .querySelectorAll("#edit-form [data-kind]")
      .forEach((el) => {
        const wantKind = el.dataset.kind;
        if (wantKind === "aicoder") el.hidden = isReviewer;
        else if (wantKind === "reviewer") el.hidden = !isReviewer;
      });

    // Source dropdown: hide aicoder-only options when reviewer, restore
    // when aicoder. Using `disabled` would still let them keyboard-select;
    // pulling them out of the DOM is cleaner. We stash the removed options
    // on the select element so we can put them back without re-querying.
    const sourceSelect = $("#edit-form select[name=source]");
    if (sourceSelect) {
      if (isReviewer) {
        if (!sourceSelect._aicoderOnly) {
          sourceSelect._aicoderOnly = Array.from(sourceSelect.options).filter(
            (opt) => opt.dataset.kind === "aicoder",
          );
        }
        for (const opt of sourceSelect._aicoderOnly) opt.remove();
        // If the currently-selected source is now invalid, snap to github.
        if (![...sourceSelect.options].some((o) => o.value === sourceSelect.value)) {
          sourceSelect.value = "github";
          // Fire change so dependent UI (repo dropdown, url row) refreshes.
          sourceSelect.dispatchEvent(new Event("change"));
        }
      } else if (sourceSelect._aicoderOnly) {
        for (const opt of sourceSelect._aicoderOnly) sourceSelect.appendChild(opt);
        sourceSelect._aicoderOnly = null;
      }
    }
  }

  /**
   * Fill blank form fields with sensible suggestions derived from the
   * selected repo. Never overwrites a user-typed value — runs on every
   * repo-pick but the empty-check makes it idempotent.
   *
   *   name  → "<kind> — <repoKey>" if blank
   *   label → platform-appropriate default (only for git platforms,
   *           since Jira issues use status/components instead)
   */
  function applyRepoSuggestions(form, item) {
    const kind = form.kind.value || "aicoder";
    if (!form.name.value.trim() && item.repoKey) {
      form.name.value = `${kind} — ${item.repoKey}`;
    }
    if (!form.label.value.trim() && (item.platform === "github" || item.platform === "gitlab")) {
      // "ready-for-agent" is a widely-used label convention for
      // aicoder/reviewer pickup queues. Reviewers default to "needs-review".
      form.label.value = kind === "reviewer" ? "needs-review" : "ready-for-agent";
    }
  }

  // ─── Auth (matches kanban.js / dashboard.js convention) ─────────────────
  // The server rejects requests without an Authorization header (or ?apiKey
  // for EventSource). The browser stores the session token in localStorage
  // under "authToken" — set by web/js/auth.js on login.
  function getAuthHeaders() {
    const token = localStorage.getItem("authToken");
    return token ? { Authorization: "Bearer " + token } : {};
  }
  function withApiKey(url) {
    const token = localStorage.getItem("authToken");
    if (!token) return url;
    return url + (url.includes("?") ? "&" : "?") + "apiKey=" + encodeURIComponent(token);
  }

  // ─── API helpers ────────────────────────────────────────────────────────
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

  // ─── Rendering ──────────────────────────────────────────────────────────
  function renderAll() {
    const grid = $("#runners-grid");
    const empty = $("#empty-state");
    const runners = [...state.runners.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    grid.querySelectorAll(".rn-card").forEach((el) => el.remove());
    if (!runners.length) {
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    for (const r of runners) {
      grid.appendChild(renderCard(r));
    }
  }

  function renderCard(r) {
    const el = document.createElement("section");
    el.className = "rn-card";
    el.dataset.id = r.id;

    const head = document.createElement("div");
    head.className = "rn-card-head";
    head.innerHTML = `
      <div>
        <span class="rn-card-name"></span>
        <span class="rn-badge rn-badge--${r.kind}">${r.kind}</span>
      </div>
      <span class="rn-status rn-status--${r.status}">
        <span class="rn-status-dot"></span>
        <span class="rn-status-text"></span>
      </span>
    `;
    head.querySelector(".rn-card-name").textContent = r.name;
    head.querySelector(".rn-status-text").textContent = r.status;
    el.appendChild(head);

    if (r.currentRunId || r.lastStartedAt || r.currentIssue) {
      const cur = document.createElement("div");
      cur.className = "rn-current";
      // Prefer the live issue id that the child aicoder reported via
      // agent_runs.issueId (enriched server-side). Falls back to the
      // configured one-shot target or a generic "polling…" placeholder.
      const issue = r.currentIssue || r.targetIssue || "(polling…)";
      const sprint = r.currentSprint ? ` · ${r.currentSprint}` : "";
      const since = r.lastStartedAt ? new Date(r.lastStartedAt).toLocaleTimeString() : "";
      cur.innerHTML = `
        <span class="rn-current-label">Current</span>
        <span></span>
      `;
      cur.querySelector("span:last-child").textContent =
        r.status === "running"
          ? `${issue}${sprint} — started ${since}`
          : r.lastFinishedAt
            ? `Last cycle: ${new Date(r.lastFinishedAt).toLocaleString()}`
            : "Idle";
      el.appendChild(cur);
    }

    const meta = document.createElement("dl");
    meta.className = "rn-meta";
    const rows = [
      ["Source", r.source],
      ["Owner/Repo", [r.owner, r.repo].filter(Boolean).join(" / ") || "—"],
      ["Label filter", r.label || "(none)"],
      ["Sprint filter", r.sprint || "(none)"],
      ["Agent", `${r.agent}${r.model ? " · " + r.model : ""}${r.apiProvider ? " · " + r.apiProvider : ""}${r.apiProviderHostId ? " @ " + (state.hosts.find((h) => h.id === r.apiProviderHostId)?.name || "(saved host)") : ""}`],
      ["Poll", `${Math.round(r.pollIntervalMs / 1000)}s`],
      ["Workspace", r.workspacePath || "(provisioned on first run)"],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      meta.appendChild(dt);
      meta.appendChild(dd);
    }
    el.appendChild(meta);

    if (r.lastError) {
      const err = document.createElement("div");
      err.className = "rn-error";
      err.textContent = r.lastError;
      el.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.className = "rn-actions";
    const btn = (label, handler, extraClass = "") => {
      const b = document.createElement("button");
      b.className = `rn-btn ${extraClass}`;
      b.textContent = label;
      b.onclick = handler;
      return b;
    };
    if (r.enabled) {
      actions.appendChild(btn("Pause", () => act(r.id, "pause")));
    } else {
      actions.appendChild(btn("Start", () => act(r.id, "start"), "rn-btn-primary"));
    }
    actions.appendChild(btn("Stop", () => act(r.id, "stop")));
    actions.appendChild(btn("Run now", () => act(r.id, "run-now")));
    actions.appendChild(btn("Logs", () => openLogs(r)));
    actions.appendChild(btn("Edit", () => openEdit(r)));
    actions.appendChild(btn("Delete", () => deleteRunner(r), "rn-btn-danger"));
    el.appendChild(actions);

    return el;
  }

  async function act(id, action) {
    try {
      await api(`/api/runners/${id}/${action}`, { method: "POST" });
    } catch (err) {
      alert(`Action failed: ${err.message}`);
    }
  }

  async function deleteRunner(r) {
    if (!confirm(`Delete runner "${r.name}"? This will stop it first.`)) return;
    try {
      await api(`/api/runners/${r.id}`, { method: "DELETE" });
      state.runners.delete(r.id);
      renderAll();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  // ─── Repo + branch comboboxes ───────────────────────────────────────────
  function ensureCombos() {
    if (!window.Combobox) return false;
    const repoMount = $("#repo-combo");
    const branchMount = $("#branch-combo");
    if (!repoMount || !branchMount) return false;

    if (!state.repoCombo) {
      state.repoCombo = window.Combobox.create({
        mount: repoMount,
        name: null,
        placeholder: "Select source first…",
        items: [],
        allowFree: false,
        onSelect: (_value, item) => {
          const form = $("#edit-form");
          if (!item) return;
          form.owner.value = item.owner || "";
          form.repo.value = item.repoKey;
          form.repoKey.value = item.repoKey;
          // GitHub/GitLab carry a clone URL + default branch; Jira/work_items
          // don't, so we leave those fields alone for manual entry.
          if (item.cloneUrl) form.repoUrl.value = item.cloneUrl;
          if (item.defaultBranch && !form.baseBranch.value) {
            form.baseBranch.value = item.defaultBranch;
            if (state.branchCombo) state.branchCombo.setValue(item.defaultBranch);
          }
          // Auto-suggest sensible defaults for blank fields. We never
          // overwrite user-typed values — only fill what's empty.
          applyRepoSuggestions(form, item);
          loadBranchesFor({
            platform: item.platform,
            repoKey: item.repoKey,
            repoUrl: form.repoUrl.value,
            preferredDefault: item.defaultBranch,
          });
        },
      });
    }
    if (!state.branchCombo) {
      state.branchCombo = window.Combobox.create({
        mount: branchMount,
        name: null,
        placeholder: "Pick a branch…",
        items: [],
        allowFree: true, // tolerate manual entry if the API returned nothing
        onSelect: (value) => {
          $("#edit-form").baseBranch.value = value || "";
        },
      });
    }

    const hostMount = $("#host-combo");
    if (hostMount && !state.hostCombo) {
      state.hostCombo = window.Combobox.create({
        mount: hostMount,
        name: null,
        placeholder: "Default (use server env)",
        items: [],
        allowFree: false,
        onSelect: (value, item) => {
          const form = $("#edit-form");
          form.apiProviderHostId.value = value || "";
          // Edit button only enabled when a saved host is selected
          const editBtn = $("#edit-host-btn");
          if (editBtn) editBtn.hidden = !value;
          // Repopulate the model combobox from the chosen host
          if (value) loadModelsForHost(value);
          else if (state.modelCombo) {
            state.modelCombo.setItems([]);
            $("#reload-models")?.setAttribute("hidden", "");
          }
        },
      });
    }

    const modelMount = $("#model-combo");
    if (modelMount && !state.modelCombo) {
      state.modelCombo = window.Combobox.create({
        mount: modelMount,
        name: null,
        placeholder: "(provider default)",
        items: [],
        allowFree: true, // models can be free-text when no host is selected
        onSelect: (value) => {
          $("#edit-form").model.value = value || "";
        },
      });
    }
    return true;
  }

  // ─── Provider hosts ─────────────────────────────────────────────────────
  /**
   * Refresh the saved-hosts cache and repopulate the Host combobox for the
   * currently-selected API provider. Called on form open and any time the
   * API provider <select> changes or a host is created/edited/deleted.
   */
  async function loadHostsForProvider(provider) {
    if (!ensureCombos()) return;
    const hostField = $("#host-field");
    if (!REMOTEABLE_PROVIDERS.has(provider)) {
      // Provider doesn't support remote hosts — hide the picker, detach any
      // previously-selected host so the runner falls back to env defaults.
      hostField.hidden = true;
      $("#edit-form").apiProviderHostId.value = "";
      if (state.hostCombo) state.hostCombo.setItems([]);
      $("#edit-host-btn").hidden = true;
      return;
    }
    hostField.hidden = false;
    try {
      const { hosts } = await api(
        `/api/provider-hosts?provider=${encodeURIComponent(provider)}`,
      );
      state.hosts = hosts || [];
    } catch (err) {
      console.warn("Failed to load hosts:", err.message);
      state.hosts = [];
    }
    state.hostCombo.setItems(
      state.hosts.map((h) => ({
        value: h.id,
        label: h.name,
        hint: h.baseUrl + (h.notes ? ` · ${h.notes}` : ""),
      })),
    );
    const currentId = $("#edit-form").apiProviderHostId.value;
    if (currentId && state.hosts.some((h) => h.id === currentId)) {
      state.hostCombo.setValue(currentId);
      $("#edit-host-btn").hidden = false;
      loadModelsForHost(currentId);
    }
  }

  async function loadModelsForHost(hostId, { force = false } = {}) {
    if (!ensureCombos()) return;
    let names = !force ? state.modelCache.get(hostId) : null;
    if (!names) {
      try {
        const data = await api(`/api/provider-hosts/${hostId}/models`);
        names = data.models || [];
        state.modelCache.set(hostId, names);
      } catch (err) {
        names = [];
        console.warn("Failed to load models from host:", err.message);
      }
    }
    state.modelCombo.setItems(names.map((n) => ({ value: n, label: n })));
    $("#reload-models")?.removeAttribute("hidden");
    const current = $("#edit-form").model.value;
    if (current) state.modelCombo.setValue(current);
  }

  // ─── Add/edit host modal (delegated to window.HostModal) ────────────────
  // The actual modal markup + lifecycle lives in /js/host-modal.js so the
  // chat page and /runners share the same UI. Callbacks below re-sync the
  // local host cache + runner form whenever a host is saved or deleted.
  function openHostModal(host) {
    const runnerForm = $("#edit-form");
    window.HostModal.open({
      provider: runnerForm.apiProvider.value || "ollama",
      host,
      onSaved: async (saved) => {
        state.modelCache.delete(saved.id);
        await loadHostsForProvider(runnerForm.apiProvider.value || "");
        if (state.hostCombo) state.hostCombo.setValue(saved.id);
        runnerForm.apiProviderHostId.value = saved.id;
        $("#edit-host-btn").hidden = false;
        loadModelsForHost(saved.id, { force: true });
      },
      onDeleted: async (deletedId) => {
        if (runnerForm.apiProviderHostId.value === deletedId) {
          runnerForm.apiProviderHostId.value = "";
          if (state.hostCombo) state.hostCombo.setValue("");
          $("#edit-host-btn").hidden = true;
        }
        await loadHostsForProvider(runnerForm.apiProvider.value || "");
      },
    });
  }

  /**
   * Load the repo dropdown for the currently selected source. Called on form
   * open and any time the source <select> changes.
   */
  async function loadReposForSource(source) {
    if (!ensureCombos()) return;
    const placeholder = source && source !== "auto"
      ? `Search ${source} projects…`
      : "Search projects…";
    const repoMount = $("#repo-combo");
    repoMount.querySelector(".cbx-input")?.setAttribute("placeholder", placeholder);

    try {
      const url = source && source !== "auto"
        ? `/api/runners/meta/repos?source=${encodeURIComponent(source)}`
        : "/api/runners/meta/repos";
      const data = await api(url);
      state.repoOptions = data.repos || [];
      state.repoCombo.setItems(
        state.repoOptions.map((r) => ({
          value: r.repoKey,
          label: r.repoName,
          hint: r.platform + (r.issueCount ? ` · ${r.issueCount} issues` : ""),
          ...r,
        })),
      );
    } catch (err) {
      console.warn(`Failed to load ${source || "all"} projects:`, err.message);
      state.repoOptions = [];
      state.repoCombo.setItems([]);
    }
  }

  async function loadBranchesFor({ platform, repoKey, repoUrl, preferredDefault }) {
    if (!ensureCombos()) return;
    const cacheKey = `${platform || ""}:${repoKey || ""}:${repoUrl || ""}`;
    let names = state.branchCache.get(cacheKey);
    if (!names) {
      const params = new URLSearchParams();
      if (platform) params.set("platform", platform);
      if (repoKey) params.set("repo", repoKey);
      if (repoUrl) params.set("repoUrl", repoUrl);
      try {
        const data = await api(`/api/runners/meta/branches?${params.toString()}`);
        names = data.branches || [];
        state.branchCache.set(cacheKey, names);
      } catch (err) {
        names = [];
        console.warn("Failed to load branches:", err.message);
      }
    }
    state.branchCombo.setItems(names.map((n) => ({ value: n, label: n })));
    const form = $("#edit-form");
    const current = form.baseBranch.value;
    if (current && names.includes(current)) {
      state.branchCombo.setValue(current);
    } else if (preferredDefault && names.includes(preferredDefault)) {
      state.branchCombo.setValue(preferredDefault);
      form.baseBranch.value = preferredDefault;
    } else if (!names.length && current) {
      // Free-text fallback — keep whatever's in the form so users can type
      state.branchCombo.setValue(current);
    }
  }

  // ─── Edit modal ─────────────────────────────────────────────────────────
  function openEdit(r) {
    const modal = $("#edit-modal");
    const form = $("#edit-form");
    const title = $("#edit-modal-title");
    ensureCombos();
    if (r) {
      title.textContent = `Edit ${r.kind}`;
      state.editingRunnerId = r.id;
      form.id.value = r.id;
      form.kind.value = r.kind;
      form.name.value = r.name;
      form.agent.value = r.agent;
      form.model.value = r.model || "";
      form.apiProvider.value = r.apiProvider || "";
      form.apiProviderHostId.value = r.apiProviderHostId || "";
      form.source.value = r.source;
      form.owner.value = r.owner || "";
      form.repo.value = r.repo || "";
      form.repoKey.value = r.repo || "";
      form.label.value = r.label || "";
      form.sprint.value = r.sprint || "";
      form.targetIssue.value = r.targetIssue || "";
      form.repoUrl.value = r.repoUrl || "";
      form.baseBranch.value = r.baseBranch || "";
      form.pollIntervalMs.value = r.pollIntervalMs;
      form.maxCycles.value = r.maxCycles;
      form.enabled.checked = r.enabled;
      loadReposForSource(r.source).then(() => {
        if (state.repoCombo) state.repoCombo.setValue(r.repo || "");
      });
      if (state.branchCombo) state.branchCombo.setValue(r.baseBranch || "");
      if (r.repo || r.repoUrl) {
        loadBranchesFor({
          platform: r.source,
          repoKey: r.repo || undefined,
          repoUrl: r.repoUrl || undefined,
          preferredDefault: r.baseBranch || undefined,
        });
      }
      // Preload model + hosts for the saved provider so the comboboxes show
      // the chosen values (and the dropdown is populated with siblings).
      if (state.modelCombo) state.modelCombo.setValue(r.model || "");
      loadHostsForProvider(r.apiProvider || "");
      updateKindFieldVisibility(r.kind);
      // Populate reviewer-only fields when editing a reviewer
      if (r.kind === "reviewer") {
        form.workspacePath.value = r.workspacePath || "";
        if (form.targetMR) form.targetMR.value = r.targetMR || r.targetIssue || "";
      }
      updateRepoUrlVisibility(r.source);
    }
    modal.hidden = false;
  }

  function openNew(kind) {
    const form = $("#edit-form");
    form.reset();
    state.editingRunnerId = null;
    form.id.value = "";
    form.kind.value = kind;
    form.source.value = "github";
    form.pollIntervalMs.value = 60000;
    form.maxCycles.value = 0;
    form.enabled.checked = true;
    form.apiProviderHostId.value = "";
    form.model.value = "";
    ensureCombos();
    if (state.repoCombo) state.repoCombo.setValue("");
    if (state.branchCombo) {
      state.branchCombo.setItems([]);
      state.branchCombo.setValue("");
    }
    if (state.hostCombo) state.hostCombo.setValue("");
    if (state.modelCombo) {
      state.modelCombo.setItems([]);
      state.modelCombo.setValue("");
    }
    updateKindFieldVisibility(kind);
    loadReposForSource(form.source.value);
    loadHostsForProvider(form.apiProvider.value || "");
    updateRepoUrlVisibility(form.source.value);
    $("#edit-modal-title").textContent = `New ${kind}`;
    $("#edit-modal").hidden = false;
  }

  async function submitEdit(e) {
    e.preventDefault();
    const form = e.target;
    const kind = form.kind.value;
    const isReviewer = kind === "reviewer";

    // Fields common to both kinds
    const data = {
      name: form.name.value.trim(),
      kind,
      model: form.model.value.trim() || null,
      apiProvider: form.apiProvider.value || null,
      apiProviderHostId: form.apiProviderHostId.value || null,
      source: form.source.value,
      owner: form.owner.value.trim() || null,
      repo: form.repo.value.trim() || null,
      pollIntervalMs: parseInt(form.pollIntervalMs.value, 10) || 60000,
      maxCycles: parseInt(form.maxCycles.value, 10) || 0,
      enabled: form.enabled.checked,
    };

    if (isReviewer) {
      // Reviewer never shells out to a coding agent. Server requires the
      // field to be present; "opencode" is the safest no-op default since
      // the reviewer arg builder ignores it.
      data.agent = "opencode";
      data.workspacePath = form.workspacePath?.value.trim() || null;
      // Reuse targetIssue column for the MR/PR number — runner-loop maps
      // it to reviewer's --review-mr at child-process spawn time.
      const mr = form.targetMR?.value.trim();
      data.targetIssue = mr || null;
      data.label = null;
      data.sprint = null;
      data.repoUrl = null;
      data.baseBranch = null;
    } else {
      data.agent = form.agent.value;
      data.label = form.label.value.trim() || null;
      data.sprint = form.sprint.value.trim() || null;
      data.targetIssue = form.targetIssue.value.trim() || null;
      data.repoUrl = form.repoUrl.value.trim() || null;
      data.baseBranch = form.baseBranch.value.trim() || null;
    }

    try {
      // editingRunnerId is the load-bearing signal — the form's hidden
      // `id` field is a fallback for any flow that bypassed openEdit
      // (e.g. an external script preloading the form), but the closure
      // value wins when both are present.
      const editId = state.editingRunnerId || form.id.value || "";
      if (editId) {
        await api(`/api/runners/${editId}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        });
      } else {
        await api(`/api/runners`, {
          method: "POST",
          body: JSON.stringify(data),
        });
      }
      state.editingRunnerId = null;
      $("#edit-modal").hidden = true;
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  }

  // ─── Logs modal ─────────────────────────────────────────────────────────
  function openLogs(r) {
    $("#logs-runner-name").textContent = r.name;
    const pane = $("#log-pane");
    pane.textContent = "";
    $("#logs-modal").hidden = false;

    if (state.logSource) {
      state.logSource.close();
      state.logSource = null;
    }
    const es = new EventSource(withApiKey(`/api/runners/${r.id}/logs`));
    state.logSource = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.chunk) {
          pane.textContent += data.chunk;
          pane.scrollTop = pane.scrollHeight;
        }
      } catch {
        // Ignore non-JSON keep-alives
      }
    };
    es.onerror = () => {
      // Browser will retry automatically; no-op here.
    };
  }

  function closeLogs() {
    if (state.logSource) {
      state.logSource.close();
      state.logSource = null;
    }
    $("#logs-modal").hidden = true;
  }

  // ─── Event stream ───────────────────────────────────────────────────────
  function subscribeEvents() {
    if (state.eventSource) state.eventSource.close();
    const es = new EventSource(withApiKey(`/api/runners/events`));
    state.eventSource = es;
    es.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === "runner.created" || evt.type === "runner.updated" || evt.type === "runner.status") {
          // SSE events emit the raw Runner row without the server-side
          // currentIssue + currentSprint enrichment. Merge with the
          // previous values so the "Processing SIEM-8 · Sprint 12" line
          // doesn't blink to "(polling…)" between refreshes.
          const prev = state.runners.get(evt.runner.id);
          const merged = { ...evt.runner };
          if (prev?.currentIssue && merged.currentIssue === undefined) {
            merged.currentIssue = prev.currentIssue;
          }
          if (prev?.currentSprint && merged.currentSprint === undefined) {
            merged.currentSprint = prev.currentSprint;
          }
          state.runners.set(evt.runner.id, merged);
          renderAll();
        } else if (evt.type === "runner.deleted") {
          state.runners.delete(evt.runnerId);
          renderAll();
        }
      } catch {}
    };
  }

  // ─── Boot ───────────────────────────────────────────────────────────────
  async function refresh() {
    try {
      // Load runners + the full host list in parallel — host list feeds the
      // "Agent" meta row on each card so we resolve host names on first paint
      // rather than only after the user opens the edit modal.
      const [runnersRes, hostsRes] = await Promise.all([
        api("/api/runners"),
        api("/api/provider-hosts").catch(() => ({ hosts: [] })),
      ]);
      state.hosts = hostsRes.hosts || [];
      state.runners.clear();
      for (const r of runnersRes.runners) state.runners.set(r.id, r);
      renderAll();
    } catch (err) {
      console.error("Failed to load runners:", err);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#add-aicoder").addEventListener("click", () => openNew("aicoder"));
    $("#add-reviewer").addEventListener("click", () => openNew("reviewer"));
    $("#refresh").addEventListener("click", refresh);
    $("#edit-form").addEventListener("submit", submitEdit);
    document.body.addEventListener("click", (e) => {
      if (e.target.matches("[data-close]")) {
        const modal = e.target.closest(".rn-modal");
        if (modal?.id === "logs-modal") closeLogs();
        else if (modal) modal.hidden = true;
      }
    });

    // Source change → re-populate the repo dropdown for the new source. Clear
    // any previously-selected repo so we don't carry a stale value across.
    const form = $("#edit-form");
    form.source.addEventListener("change", () => {
      form.repo.value = "";
      form.repoKey.value = "";
      form.owner.value = "";
      if (state.repoCombo) state.repoCombo.setValue("");
      if (state.branchCombo) {
        state.branchCombo.setItems([]);
        state.branchCombo.setValue("");
      }
      updateRepoUrlVisibility(form.source.value);
      loadReposForSource(form.source.value);
    });

    // Reload branches when the user has typed a custom repoUrl (Jira /
    // work_items flow) and wants the dropdown re-populated.
    $("#reload-branches")?.addEventListener("click", () => {
      loadBranchesFor({
        platform: form.source.value,
        repoKey: form.repo.value || undefined,
        repoUrl: form.repoUrl.value || undefined,
        preferredDefault: form.baseBranch.value || undefined,
      });
    });

    // API provider change → show/hide host picker + reload its options. Also
    // clear the selected host so we don't keep a stale ollama host pointer
    // when the user flips to a non-remoteable provider.
    form.apiProvider.addEventListener("change", () => {
      form.apiProviderHostId.value = "";
      if (state.hostCombo) state.hostCombo.setValue("");
      if (state.modelCombo) {
        state.modelCombo.setItems([]);
      }
      loadHostsForProvider(form.apiProvider.value || "");
    });

    // Add/edit provider host — handled by the shared HostModal (its own
    // submit/test/delete buttons live inside the modal markup it injects).
    $("#add-host-btn")?.addEventListener("click", () => openHostModal(null));
    $("#edit-host-btn")?.addEventListener("click", () => {
      const id = form.apiProviderHostId.value;
      const host = state.hosts.find((h) => h.id === id);
      if (host) openHostModal(host);
    });
    $("#reload-models")?.addEventListener("click", () => {
      const id = form.apiProviderHostId.value;
      if (id) loadModelsForHost(id, { force: true });
    });

    refresh().then(() => maybeOpenFromQuery());
    subscribeEvents();
    // Repo list is now loaded lazily based on source — no eager fetch.
  });

  /**
   * Support deep-links from kanban / dashboard:
   *   /runners?new=aicoder&repo=owner%2Frepo&source=github
   *   /runners?edit=<id>
   *   /runners?logs=<id>
   */
  function maybeOpenFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const newKind = params.get("new");
    const editId = params.get("edit");
    const logsId = params.get("logs");
    if (newKind === "aicoder" || newKind === "reviewer") {
      openNew(newKind);
      const form = $("#edit-form");
      const repo = params.get("repo");
      const owner = params.get("owner");
      const source = params.get("source");
      const sprint = params.get("sprint");
      const issue = params.get("issue");
      const repoUrl = params.get("repoUrl");
      const baseBranch = params.get("baseBranch");
      if (repo) form.repo.value = repo;
      if (owner) form.owner.value = owner;
      if (source) form.source.value = source;
      if (sprint) form.sprint.value = sprint;
      if (issue) form.targetIssue.value = issue;
      if (repoUrl) form.repoUrl.value = repoUrl;
      if (baseBranch) form.baseBranch.value = baseBranch;
      if (repo) form.name.value = `${newKind} — ${repo}`;
      // Reload the repo list for the chosen source, then select the preset.
      const effectiveSource = source || form.source.value;
      if (effectiveSource) {
        updateRepoUrlVisibility(effectiveSource);
        loadReposForSource(effectiveSource).then(() => {
          if (state.repoCombo && repo) state.repoCombo.setValue(repo);
        });
      }
      if (state.branchCombo && baseBranch) state.branchCombo.setValue(baseBranch);
      if (repo || repoUrl) {
        loadBranchesFor({
          platform: effectiveSource,
          repoKey: repo || undefined,
          repoUrl: repoUrl || undefined,
          preferredDefault: baseBranch || undefined,
        });
      }
    } else if (editId && state.runners.has(editId)) {
      openEdit(state.runners.get(editId));
    } else if (logsId && state.runners.has(logsId)) {
      openLogs(state.runners.get(logsId));
    }
  }
})();
