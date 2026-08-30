/** Canonical object boundary guard for untrusted JSON and IPC values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
