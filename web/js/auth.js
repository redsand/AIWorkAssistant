import {
  API_BASE,
  authToken,
  setAuthToken,
  setCurrentSessionId,
} from "./state.js";

export function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

export async function checkAuth() {
  const { showLoginOverlay, hideLoginOverlay } = await import("./ui.js");
  const { initializeChat } = await import("./chat.js");
  const { loadRoadmaps } = await import("./sidebar.js");
  const { loadConversations } = await import("./conversations.js");

  if (!authToken) {
    showLoginOverlay();
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/verify`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (response.status === 401 || response.status === 403) {
      setAuthToken(null);
      localStorage.removeItem("authToken");
      showLoginOverlay();
      return;
    }

    hideLoginOverlay();
    initializeChat();
    loadRoadmaps();
    loadConversations();
  } catch (error) {
    hideLoginOverlay();
    initializeChat();
    loadRoadmaps();
    loadConversations();
  }
}

export async function login() {
  const { hideLoginOverlay } = await import("./ui.js");
  const { initializeChat } = await import("./chat.js");
  const { loadRoadmaps } = await import("./sidebar.js");

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const loginBtn = document.getElementById("loginBtn");
  const loginError = document.getElementById("loginError");

  loginError.classList.remove("visible");

  if (!username || !password) {
    loginError.textContent = "Please enter both username and password.";
    loginError.classList.add("visible");
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in...";

  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      setAuthToken(data.token);
      localStorage.setItem("authToken", data.token);
      hideLoginOverlay();
      initializeChat();
      loadRoadmaps();
    } else {
      loginError.textContent = data.error || "Invalid credentials.";
      loginError.classList.add("visible");
    }
  } catch (error) {
    loginError.textContent = "Unable to connect to the server.";
    loginError.classList.add("visible");
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign In";
  }
}

export async function logout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch (error) {}

  setAuthToken(null);
  localStorage.removeItem("authToken");
  localStorage.removeItem("currentSessionId");
  setCurrentSessionId(null);

  const { showLoginOverlay } = await import("./ui.js");
  showLoginOverlay();
}
