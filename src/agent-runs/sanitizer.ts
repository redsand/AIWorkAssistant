const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "api_key",
  "token",
  "password",
  "authorization",
  "secret",
  "access_token",
  "refresh_token",
]);

const REDACTED = "[REDACTED]";

export function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      result[key] = REDACTED;
    } else {
      result[key] = sanitizeValue(val);
    }
  }
  return result;
}