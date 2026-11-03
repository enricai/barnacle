/**
 * Replay-safety predicate: only side-effect-free captures are replayed by
 * default. GET/HEAD/OPTIONS are safe; a GraphQL POST is safe only when its
 * document is a query operation.
 */

export interface ReplayCandidate {
  method: string;
  query?: string | null;
  operationName?: string | null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Strips comments and string literals so keyword scans see only syntax. */
function stripGraphqlNoise(doc: string): string {
  return doc
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/#[^\n\r]*/g, " ");
}

/** True when every operation in the document is a query (anonymous `{...}` counts). */
export function isGraphqlQueryDocument(doc: string): boolean {
  const s = stripGraphqlNoise(doc);
  let depth = 0;
  let sawOp = false;
  const re = /[{}]|\b(query|mutation|subscription)\b/g;
  for (;;) {
    const m = re.exec(s);
    if (m === null) break;
    if (m[0] === "{") {
      if (depth === 0) sawOp = true; // anonymous query shorthand or operation body
      depth++;
    } else if (m[0] === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (m[1] !== "query") return false;
      sawOp = true;
    }
  }
  return sawOp;
}

/** Returns the reason a capture is unsafe to replay, or null when safe. */
export function unsafeReplayReason(c: ReplayCandidate): string | null {
  const method = (c.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return null;
  if (method === "POST" && c.operationName && c.query) {
    return isGraphqlQueryDocument(c.query)
      ? null
      : `unsafe GraphQL operation (mutation/subscription) "${c.operationName}"`;
  }
  return `unsafe method ${method}`;
}

export function isSafeToReplay(c: ReplayCandidate): boolean {
  return unsafeReplayReason(c) === null;
}
