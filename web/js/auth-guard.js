/**
 * Centralized session-expiry detector for every web UI page.
 *
 * Wraps window.fetch so any 401/403 response from the API (no matter which
 * page or helper made the call) triggers a coordinated re-auth:
 *
 *   - clears localStorage authToken (so subsequent fetches don't re-send it)
 *   - if the current page has an in-page #loginOverlay (chat does), shows it
 *   - otherwise redirects to /?redirect=<current-href> so after login the
 *     user lands back where they were
 *
 * Self-installs on script load — every HTML page just includes the script
 * tag, no init call needed. Idempotent: re-loading the script is a no-op.
 *
 * Exclusions:
 *   - /auth/login + /auth/logout + /auth/verify — these can legitimately
 *     return 401 and the caller is responsible for showing the error
 *   - cross-origin URLs — we only guard our own API
 *   - the script also debounces multiple 401s within 5s so a page that
 *     fires 10 parallel requests doesn't redirect 10 times
 */
(() => {
  if (window.__authGuardInstalled) return;
  window.__authGuardInstalled = true;

  const AUTH_EXCLUDED_PATHS = [
    "/auth/login",
    "/auth/logout",
    "/auth/verify",
  ];
  const REDIRECT_DEBOUNCE_MS = 5000;
  let lastRedirectAt = 0;

  function isAuthExcluded(url) {
    try {
      // url is whatever the caller passed: string, URL, Request
      const href = typeof url === "string" ? url : url?.url || String(url);
      const path = new URL(href, window.location.origin).pathname;
      return AUTH_EXCLUDED_PATHS.some((p) => path === p || path.endsWith(p));
    } catch {
      return false;
    }
  }

  function handleUnauthenticated() {
    const now = Date.now();
    if (now - lastRedirectAt < REDIRECT_DEBOUNCE_MS) return;
    lastRedirectAt = now;

    try {
      localStorage.removeItem("authToken");
    } catch {
      // Storage may be disabled — proceed to redirect anyway.
    }

    // Prefer the in-page overlay when one exists (chat). Falls back to
    // redirecting to / for pages that don't carry their own login UI.
    const overlay = document.getElementById("loginOverlay");
    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.hidden = false;
      return;
    }

    // Round-trip the user back to their page after login. The login flow
    // in auth.js already honors ?redirect=<url>.
    const here = window.location.pathname + window.location.search + window.location.hash;
    const redirect = encodeURIComponent(here);
    window.location.href = `/?redirect=${redirect}`;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function authGuardedFetch(input, init) {
    let response;
    try {
      response = await origFetch(input, init);
    } catch (err) {
      // Network errors propagate unchanged — not an auth concern.
      throw err;
    }
    if ((response.status === 401 || response.status === 403) && !isAuthExcluded(input)) {
      handleUnauthenticated();
    }
    return response;
  };
})();
