/**
 * Type-ahead suggestions for knowledge-graph nodes in the chat input.
 *
 * Triggers on `@` followed by ≥2 chars (anywhere in the input). Queries
 * the cached node list (in-memory, no network) and pops a small floating
 * dropdown of top matches. Up/Down arrows navigate, Enter / Tab inserts
 * the selected `[[node-id title]]` reference at the cursor and dismisses
 * the popup. Escape dismisses without inserting.
 *
 * The agent sees structured `[[id title]]` references and can resolve
 * them via knowledgeGraph.getNode without re-searching — making
 * downstream tool calls faster too.
 */

import { loadKgCache, searchKgCache } from "./kg-cache.js";

const DEBOUNCE_MS = 150;
const MIN_QUERY_LEN = 2;
const MAX_SUGGESTIONS = 6;
const POPUP_ID = "kg-typeahead-popup";
const TRIGGER_RE = /@([\w-]+)$/;

let debounceTimer = null;
let popupEl = null;
let activeInput = null;
let lastMatch = null; // { fullMatch, query, startIndex }
let highlightedIndex = -1;
let currentResults = [];

function getPopup() {
  if (popupEl && document.body.contains(popupEl)) return popupEl;
  popupEl = document.createElement("div");
  popupEl.id = POPUP_ID;
  popupEl.className = "kg-typeahead-popup";
  popupEl.style.display = "none";
  document.body.appendChild(popupEl);
  return popupEl;
}

function hidePopup() {
  if (popupEl) popupEl.style.display = "none";
  highlightedIndex = -1;
  currentResults = [];
  lastMatch = null;
}

function renderPopup(input, results) {
  const popup = getPopup();
  if (results.length === 0) {
    hidePopup();
    return;
  }
  currentResults = results;
  highlightedIndex = 0;
  const rect = input.getBoundingClientRect();
  popup.style.left = `${rect.left + window.scrollX}px`;
  popup.style.top = `${rect.top + window.scrollY - 4}px`;
  popup.style.transform = "translateY(-100%)";
  popup.style.minWidth = `${Math.min(rect.width, 480)}px`;
  popup.innerHTML = results
    .map(
      (n, i) =>
        `<div class="kg-typeahead-row${i === 0 ? " active" : ""}" data-index="${i}">
          <span class="kg-type">${escapeHtml(n.type)}</span>
          <span class="kg-title">${escapeHtml(n.title)}</span>
          ${n.status ? `<span class="kg-status kg-status-${escapeAttr(n.status)}">${escapeHtml(n.status)}</span>` : ""}
        </div>`,
    )
    .join("");
  popup.style.display = "block";

  for (const row of popup.querySelectorAll(".kg-typeahead-row")) {
    row.addEventListener("mousedown", (evt) => {
      // mousedown (not click) so we beat the input's blur that would hide the popup.
      evt.preventDefault();
      const idx = parseInt(row.dataset.index, 10);
      if (!Number.isNaN(idx)) insertReference(idx);
    });
    row.addEventListener("mouseenter", () => {
      const idx = parseInt(row.dataset.index, 10);
      if (!Number.isNaN(idx)) setHighlight(idx);
    });
  }
}

function setHighlight(i) {
  if (!popupEl) return;
  highlightedIndex = i;
  const rows = popupEl.querySelectorAll(".kg-typeahead-row");
  rows.forEach((r, idx) => r.classList.toggle("active", idx === i));
}

function insertReference(i) {
  if (!activeInput || !lastMatch || i < 0 || i >= currentResults.length) return;
  const node = currentResults[i];
  const insertion = `[[${node.id} ${node.title}]]`;
  const value = activeInput.value;
  const before = value.slice(0, lastMatch.startIndex);
  const after = value.slice(lastMatch.startIndex + lastMatch.fullMatch.length);
  activeInput.value = `${before}${insertion}${after}`;
  const newCursor = before.length + insertion.length;
  activeInput.setSelectionRange(newCursor, newCursor);
  activeInput.dispatchEvent(new Event("input", { bubbles: true }));
  hidePopup();
}

function detectTrigger(input) {
  const value = input.value || "";
  const cursor = input.selectionStart ?? value.length;
  const upToCursor = value.slice(0, cursor);
  const m = upToCursor.match(TRIGGER_RE);
  if (!m) return null;
  return {
    fullMatch: m[0],
    query: m[1],
    startIndex: cursor - m[0].length,
  };
}

async function runSearch(input) {
  const trigger = detectTrigger(input);
  if (!trigger || trigger.query.length < MIN_QUERY_LEN) {
    hidePopup();
    return;
  }
  lastMatch = trigger;
  await loadKgCache(false);
  const results = searchKgCache(trigger.query, {}, MAX_SUGGESTIONS);
  renderPopup(input, results);
}

function onInput(evt) {
  activeInput = evt.target;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSearch(evt.target), DEBOUNCE_MS);
}

function onKeyDown(evt) {
  if (!popupEl || popupEl.style.display === "none") return;
  if (evt.key === "ArrowDown") {
    evt.preventDefault();
    setHighlight(Math.min(highlightedIndex + 1, currentResults.length - 1));
  } else if (evt.key === "ArrowUp") {
    evt.preventDefault();
    setHighlight(Math.max(highlightedIndex - 1, 0));
  } else if (evt.key === "Enter" || evt.key === "Tab") {
    // Only consume Enter when the popup is open AND the user has navigated /
    // hovered a row. Otherwise let Enter submit the message as usual.
    if (highlightedIndex >= 0) {
      evt.preventDefault();
      insertReference(highlightedIndex);
    }
  } else if (evt.key === "Escape") {
    evt.preventDefault();
    hidePopup();
  }
}

function onBlur() {
  // Tiny delay so a mousedown on a popup row beats the hide.
  setTimeout(hidePopup, 100);
}

export function installKgTypeahead(input) {
  if (!input || input.dataset.kgTypeaheadInstalled === "1") return;
  input.dataset.kgTypeaheadInstalled = "1";
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);
  // Warm the cache so the first @-trigger is truly instant.
  void loadKgCache(false);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}
