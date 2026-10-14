const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 529]);
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);
const TRANSIENT_MESSAGE_RX =
  /internal server error|\boverloaded\b|bad gateway|service unavailable|gateway time-?out|socket hang up|\bECONNRESET\b|connection reset|\b(?:5\d\d)\s+(?:internal|bad|service|gateway)/i;

function readStatus(obj: Record<string, unknown>): number | null {
  for (const key of ["status", "statusCode"]) {
    const value = obj[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function readCode(obj: Record<string, unknown>): string | null {
  return typeof obj.code === "string" ? obj.code : null;
}

/**
 * One site-agnostic definition of a transient model-provider failure (5xx,
 * overload, connection reset raised at inference) so the call guard and the
 * replan guard agree. Structured status/code fields win; message text is a
 * fallback only for provider-wrapped errors that carry no status.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    const status = readStatus(obj);
    if (status !== null)
      return (status >= 500 && status < 600) || TRANSIENT_STATUS_CODES.has(status);
    const code = readCode(obj);
    if (code !== null && TRANSIENT_ERROR_CODES.has(code)) return true;
    if (obj.cause !== undefined && obj.cause !== err && isTransientProviderError(obj.cause)) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return TRANSIENT_MESSAGE_RX.test(message);
}

/**
 * Tells whether a failure dump's attempts[] errorMessage values are
 * transient, so the replan guard can avoid treating a provider outage as a
 * verdict about the step. `all` requires at least one message.
 */
export function summarizeAttemptTransience(
  attempts: ReadonlyArray<{ errorMessage?: string | null }>
): { all: boolean; any: boolean } {
  const messages = attempts
    .map((a) => a.errorMessage)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const flags = messages.map((m) => isTransientProviderError(new Error(m)));
  return { all: flags.length > 0 && flags.every(Boolean), any: flags.some(Boolean) };
}
