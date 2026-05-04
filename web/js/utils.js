export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + "..." : str;
}

export function summarizeResult(result) {
  if (!result || typeof result !== "object") return String(result);
  if (result.error) return `Error: ${result.error}`;
  if (result.message && result.tools) return result.message;
  if (result.message) return result.message;
  if (result.success === false)
    return `Failed: ${result.error || "unknown error"}`;
  const keys = Object.keys(result);
  if (keys.length === 0) return "OK";
  if (keys.length <= 3) {
    return keys
      .map((k) => `${k}: ${truncate(String(result[k]), 60)}`)
      .join(", ");
  }
  return `${keys.length} fields: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "..." : ""}`;
}

export function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}