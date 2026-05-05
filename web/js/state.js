const API_BASE = window.location.origin;
let currentMode = "productivity";
let currentSessionId = localStorage.getItem("currentSessionId") || null;
let authToken = localStorage.getItem("authToken") || null;
let messageHistory = [];
let historyIndex = -1;
let draftBeforeHistory = "";
let activeStreamController = null;
let autoAcceptDeletes = false;
let activeToolCalls = {};
let toolsPanelLoaded = false;
let todoPanelLoaded = false;
let sendGeneration = 0;

export {
  API_BASE,
  currentMode,
  currentSessionId,
  authToken,
  messageHistory,
  historyIndex,
  draftBeforeHistory,
  activeStreamController,
  autoAcceptDeletes,
  activeToolCalls,
  toolsPanelLoaded,
  todoPanelLoaded,
  sendGeneration,
};

export function setCurrentMode(v) {
  currentMode = v;
}
export function setCurrentSessionId(v) {
  currentSessionId = v;
}

export function updateSessionHash(sessionId) {
  if (sessionId) {
    window.history.replaceState(null, "", "#/chat/" + sessionId);
  } else {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

export function readSessionHash() {
  const hash = window.location.hash;
  const match = hash.match(/^#\/chat\/([a-f0-9-]+)$/i);
  return match ? match[1] : null;
}
export function setAuthToken(v) {
  authToken = v;
}
export function setMessageHistory(v) {
  messageHistory = v;
}
export function setHistoryIndex(v) {
  historyIndex = v;
}
export function setDraftBeforeHistory(v) {
  draftBeforeHistory = v;
}
export function setActiveStreamController(v) {
  activeStreamController = v;
}
export function setAutoAcceptDeletes(v) {
  autoAcceptDeletes = v;
}
export function setActiveToolCalls(v) {
  activeToolCalls = v;
}
export function setToolsPanelLoaded(v) {
  toolsPanelLoaded = v;
}
export function setTodoPanelLoaded(v) {
  todoPanelLoaded = v;
}

export function nextSendGeneration() {
  return ++sendGeneration;
}
