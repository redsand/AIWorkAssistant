/**
 * Tiny searchable combobox. Vanilla JS, no framework, no deps.
 *
 *   const cb = Combobox.create({
 *     mount: containerEl,          // host element — its innerHTML is replaced
 *     name: "repo",                // form field name (if used in a form)
 *     placeholder: "Pick a repo…",
 *     items: [{ value, label, hint? }],
 *     value: "owner/repo",         // optional initial selection
 *     allowFree: false,            // if true, free typing is also a valid value
 *     onSelect: (value, item) => {},
 *   });
 *   cb.setItems([...]); cb.setValue("foo"); cb.getValue();
 *
 * Keyboard: arrow up/down + enter + esc. Click outside to close.
 */
(() => {
  let openInstance = null;

  function create(opts) {
    const host = opts.mount;
    if (!host) throw new Error("Combobox.create needs { mount }");
    let items = opts.items || [];
    const allowFree = !!opts.allowFree;
    let value = opts.value ?? "";
    let highlight = -1;
    let lastFilter = "";

    host.classList.add("cbx");
    host.innerHTML = `
      <input type="text" class="cbx-input" autocomplete="off" spellcheck="false" />
      <button type="button" class="cbx-toggle" aria-label="Toggle options" tabindex="-1">▾</button>
      <ul class="cbx-list" role="listbox" hidden></ul>
      <input type="hidden" class="cbx-hidden" />
    `;
    const input = host.querySelector(".cbx-input");
    const toggle = host.querySelector(".cbx-toggle");
    const list = host.querySelector(".cbx-list");
    const hidden = host.querySelector(".cbx-hidden");

    if (opts.name) hidden.name = opts.name;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.required) hidden.required = true;
    if (opts.id) input.id = opts.id;

    function findItem(v) {
      return items.find((i) => i.value === v) || null;
    }

    function setValue(v, item) {
      value = v ?? "";
      hidden.value = value;
      const resolved = item || findItem(value);
      if (resolved) {
        input.value = resolved.label;
        input.dataset.selected = "1";
      } else if (allowFree) {
        // Free-text combobox: a value with no matching item is legitimate
        // (e.g. the user typed "main" but the branch list returned [])
        input.value = value;
        input.dataset.selected = "0";
      } else {
        // Picker-style combobox: the value is an opaque key (UUID, repo id)
        // that means nothing to humans. Showing it raw — observed with the
        // provider-host picker showing the host UUID after save when the
        // items list hadn't loaded yet — is worse than empty. Leave blank;
        // a follow-up setItems will trigger another setValue with the same
        // value, and *then* the label resolves.
        input.value = "";
        input.dataset.selected = "0";
      }
    }

    function filter(query) {
      const q = (query || "").toLowerCase().trim();
      if (!q) return items.slice(0, 200);
      const tokens = q.split(/\s+/).filter(Boolean);
      return items.filter((i) => {
        const hay = (i.label + " " + (i.hint || "") + " " + i.value).toLowerCase();
        return tokens.every((t) => hay.includes(t));
      }).slice(0, 200);
    }

    function render() {
      const filtered = filter(lastFilter);
      list.innerHTML = "";
      if (!filtered.length) {
        const empty = document.createElement("li");
        empty.className = "cbx-empty";
        empty.textContent = "No matches";
        list.appendChild(empty);
        return;
      }
      filtered.forEach((it, idx) => {
        const li = document.createElement("li");
        li.className = "cbx-item" + (idx === highlight ? " cbx-item--hl" : "");
        li.setAttribute("role", "option");
        li.dataset.value = it.value;
        const label = document.createElement("span");
        label.className = "cbx-item-label";
        label.textContent = it.label;
        li.appendChild(label);
        if (it.hint) {
          const hint = document.createElement("span");
          hint.className = "cbx-item-hint";
          hint.textContent = it.hint;
          li.appendChild(hint);
        }
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(it);
        });
        list.appendChild(li);
      });
    }

    function open() {
      if (openInstance && openInstance !== api) openInstance.close();
      openInstance = api;
      list.hidden = false;
      highlight = -1;
      render();
    }

    function close() {
      list.hidden = true;
      if (openInstance === api) openInstance = null;
    }

    function choose(item) {
      setValue(item.value, item);
      close();
      if (opts.onSelect) opts.onSelect(item.value, item);
    }

    function commitFree() {
      if (!allowFree) return;
      const typed = input.value.trim();
      if (typed === "" || typed === (findItem(value)?.label ?? value)) return;
      setValue(typed, null);
      if (opts.onSelect) opts.onSelect(typed, null);
    }

    input.addEventListener("focus", open);
    input.addEventListener("input", () => {
      lastFilter = input.value;
      highlight = -1;
      open();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const filtered = filter(lastFilter);
        if (!filtered.length) return;
        if (highlight === -1) highlight = e.key === "ArrowDown" ? 0 : filtered.length - 1;
        else highlight = (highlight + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length;
        render();
      } else if (e.key === "Enter") {
        const filtered = filter(lastFilter);
        if (highlight >= 0 && filtered[highlight]) {
          e.preventDefault();
          choose(filtered[highlight]);
        } else if (allowFree) {
          e.preventDefault();
          commitFree();
          close();
        }
      } else if (e.key === "Escape") {
        close();
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      // small delay so a mousedown on a list item still fires choose()
      setTimeout(() => {
        commitFree();
        close();
        // Restore label of selected value if user typed garbage
        const sel = findItem(value);
        if (sel) input.value = sel.label;
        else if (!allowFree) input.value = "";
      }, 120);
    });
    toggle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (list.hidden) {
        input.focus();
        lastFilter = "";
        open();
      } else close();
    });

    const api = {
      setItems(newItems) {
        items = newItems || [];
        if (value && !findItem(value) && !allowFree) {
          setValue("", null);
        } else if (value) {
          // refresh label
          setValue(value, findItem(value));
        }
        render();
      },
      setValue(v) {
        setValue(v, findItem(v));
      },
      getValue() {
        return value;
      },
      getItem() {
        return findItem(value);
      },
      focus() {
        input.focus();
      },
      destroy() {
        if (openInstance === api) openInstance = null;
        host.innerHTML = "";
        host.classList.remove("cbx");
      },
    };

    setValue(value, findItem(value));
    return api;
  }

  window.Combobox = { create };
})();
