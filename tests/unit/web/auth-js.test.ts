import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showLoginOverlay: vi.fn(),
  hideLoginOverlay: vi.fn(),
  initializeChat: vi.fn(),
  loadRoadmaps: vi.fn(),
  loadConversations: vi.fn(),
}));

vi.mock("../../../web/js/ui.js", () => ({
  showLoginOverlay: mocks.showLoginOverlay,
  hideLoginOverlay: mocks.hideLoginOverlay,
}));

vi.mock("../../../web/js/chat.js", () => ({
  initializeChat: mocks.initializeChat,
}));

vi.mock("../../../web/js/sidebar.js", () => ({
  loadRoadmaps: mocks.loadRoadmaps,
}));

vi.mock("../../../web/js/conversations.js", () => ({
  loadConversations: mocks.loadConversations,
}));

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

function createElement(value = "") {
  const classes = new Set<string>();
  return {
    value,
    textContent: "",
    disabled: false,
    classList: {
      add: vi.fn((name: string) => classes.add(name)),
      remove: vi.fn((name: string) => classes.delete(name)),
      contains: (name: string) => classes.has(name),
    },
  };
}

describe("web auth.js", () => {
  let storage: ReturnType<typeof createStorage>;
  let elements: Record<string, ReturnType<typeof createElement>>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storage = createStorage();
    elements = {
      username: createElement(),
      password: createElement(),
      loginBtn: createElement(),
      loginError: createElement(),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3050",
        search: "",
        href: "http://localhost:3050/",
        pathname: "/",
        hash: "",
      },
      history: { replaceState: vi.fn() },
    });
    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) => elements[id] ?? null),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds auth headers with and without a token", async () => {
    const auth = await import("../../../web/js/auth.js");
    const state = await import("../../../web/js/state.js");

    expect(auth.authHeaders()).toEqual({ "Content-Type": "application/json" });

    state.setAuthToken("token-1");

    expect(auth.authHeaders()).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });
  });

  it("shows login when unauthenticated and clears invalid stored tokens", async () => {
    const auth = await import("../../../web/js/auth.js");
    const state = await import("../../../web/js/state.js");

    await auth.checkAuth();
    expect(mocks.showLoginOverlay).toHaveBeenCalledTimes(1);

    state.setAuthToken("expired");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401 }));

    await auth.checkAuth();

    expect(storage.removeItem).toHaveBeenCalledWith("authToken");
    expect(mocks.showLoginOverlay).toHaveBeenCalledTimes(2);
  });

  it("initializes the app on verify success or verify failure", async () => {
    const auth = await import("../../../web/js/auth.js");
    const state = await import("../../../web/js/state.js");
    state.setAuthToken("token-1");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
    await auth.checkAuth();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await auth.checkAuth();

    expect(mocks.hideLoginOverlay).toHaveBeenCalledTimes(2);
    expect(mocks.initializeChat).toHaveBeenCalledTimes(2);
    expect(mocks.loadRoadmaps).toHaveBeenCalledTimes(2);
    expect(mocks.loadConversations).toHaveBeenCalledTimes(2);
  });

  it("validates login fields and handles successful login redirects", async () => {
    const auth = await import("../../../web/js/auth.js");

    await auth.login();
    expect(elements.loginError.textContent).toBe("Please enter both username and password.");
    expect(elements.loginError.classList.add).toHaveBeenCalledWith("visible");

    elements.username.value = "tim";
    elements.password.value = "secret";
    window.location.search = "?redirect=%2Facknowledge";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, token: "token-2" }),
      }),
    );

    await auth.login();

    expect(storage.setItem).toHaveBeenCalledWith("authToken", "token-2");
    expect(mocks.hideLoginOverlay).toHaveBeenCalled();
    expect(window.location.href).toBe("/acknowledge");
    expect(elements.loginBtn.disabled).toBe(false);
    expect(elements.loginBtn.textContent).toBe("Sign In");
  });
});
