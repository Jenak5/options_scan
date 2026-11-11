/**
 * Flow tab failure. A Schwab reconnect link is shown only when this response
 * includes one. A timeout, a 503, or any other error keeps the server's text.
 */

export interface FlowPageBody {
  connected?: unknown;
  error?: unknown;
  reconnect?: unknown;
}

export type FlowPageFailure =
  | { kind: "reconnect"; message: string; href: string }
  | { kind: "error"; message: string };

export function flowPageFailure(status: number, body: FlowPageBody | null): FlowPageFailure | null {
  const row = body && typeof body === "object" ? body : {};
  const href = typeof row.reconnect === "string" ? row.reconnect.trim() : "";
  const message = typeof row.error === "string" ? row.error.trim() : "";
  if (href && (row.connected === false || status === 409)) {
    return {
      kind: "reconnect",
      href,
      message: message || "Schwab is not connected. Use Reconnect Schwab.",
    };
  }
  if (row.connected === false || status === 409 || status === 503 || status >= 400 || message.length > 0) {
    return { kind: "error", message: message || "Market data request failed." };
  }
  return null;
}
