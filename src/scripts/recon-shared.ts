/**
 * Shared types and utilities for the recon pipeline scripts.
 * Extracted so recon-summarize.ts and recon-generate.ts stay consistent
 * without duplicating the core data model or header-tally logic.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { format } from "date-fns";
import { z } from "zod";
import { getScriptLogger } from "@/lib/logging";
import { isRawCaptureFilename } from "@/recon/capture-filters";

const logger = getScriptLogger("recon-shared");

/** Subdirectory names created under every resolved recon run root. */
const RUN_SUBDIRS = [
  "graphql",
  "cookies",
  "replays",
  "aux",
  "step-failures",
  "step-heals",
] as const;

export interface ReconRunDir {
  runId: string;
  root: string;
  graphqlDir: string;
  cookiesDir: string;
  replaysDir: string;
  auxDir: string;
  stepFailuresDir: string;
  stepHealsDir: string;
}

/** Memoized so repeated calls within one process share a single run root and runId. */
let memoizedRunDir: ReconRunDir | null = null;

function generateRunId(): string {
  const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 4);
  return `${timestamp}-${suffix}`;
}

/** Base directory every recon run is rooted under; `RECON_OUT_DIR` overrides the `/tmp/recon` default. */
function reconOutBaseDir(): string {
  return process.env.RECON_OUT_DIR || "/tmp/recon";
}

/**
 * Resolves (and creates) the run-scoped root directory recon scripts should
 * write output under, namespacing every run so concurrent or repeated runs
 * stop silently colliding in a shared `/tmp/recon` tree. Memoized per
 * process so a run's counter-based filenames stay in one namespace across
 * every call site.
 *
 * `RECON_RUN_ID` pins a deterministic runId (e.g. for tests or replays of a
 * known run); `RECON_OUT_DIR` overrides the base directory runs are rooted
 * under (default `/tmp/recon`).
 */
export function resolveReconRunDir(): ReconRunDir {
  if (memoizedRunDir) {
    return memoizedRunDir;
  }

  const runId = process.env.RECON_RUN_ID || generateRunId();
  const baseDir = reconOutBaseDir();
  return adoptReconRunRoot(join(baseDir, runId), runId);
}

/**
 * Adopts an existing run root as this process's run dir (creating any missing
 * subdirs) instead of minting a new one, so a reader-phase script such as
 * recon-http works on the run it was pointed at without nesting a fresh run.
 */
export function adoptReconRunRoot(root: string, runId: string = basename(root)): ReconRunDir {
  const runDir: ReconRunDir = {
    runId,
    root,
    graphqlDir: join(root, "graphql"),
    cookiesDir: join(root, "cookies"),
    replaysDir: join(root, "replays"),
    auxDir: join(root, "aux"),
    stepFailuresDir: join(root, "step-failures"),
    stepHealsDir: join(root, "step-heals"),
  };

  for (const subdir of RUN_SUBDIRS) {
    mkdirSync(join(root, subdir), { recursive: true });
  }

  logger.info(`resolved recon run dir: runId=${runId}, root=${root}`);
  memoizedRunDir = runDir;
  return memoizedRunDir;
}

/**
 * Resolves the run root a reader (recon-generate, recon-summarize) should
 * read from: an explicit `runDir` wins, `RECON_RUN_ID` pins a specific run
 * under the base dir, and otherwise this picks the most recently modified
 * run subdirectory — the run root recon-browser/recon-http just wrote to —
 * so the existing "recon, then generate" two-command workflow keeps working
 * without operators passing a run dir by hand.
 */
export function resolveLatestReconRunRoot(runDir?: string): string {
  if (runDir) return runDir;

  const baseDir = reconOutBaseDir();
  if (process.env.RECON_RUN_ID) return join(baseDir, process.env.RECON_RUN_ID);

  const candidates = (() => {
    try {
      return readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(baseDir, entry.name));
    } catch {
      return [] as string[];
    }
  })();

  const latest = candidates
    .map((dir) => ({ dir, mtimeMs: statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.dir;

  if (!latest) {
    logger.info(`no recon run roots found under ${baseDir}; falling back to legacy path`);
    return baseDir;
  }

  logger.info(`resolved latest recon run root: ${latest}`);
  return latest;
}

export interface Capture {
  timestamp: string;
  phase: string;
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  requestPostData: string | null;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  operationName: string | null;
  query: string | null;
  variables: unknown;
  decodedParams: unknown;
}

/**
 * A single cookie as reported by CDP's Network.getAllCookies. Field names and
 * types match the CDP Network.Cookie type verbatim so no lossy remap step is
 * needed between capture and disk. `expires` stays the raw CDP number
 * (-1 for session cookies) — readers format it, not this layer.
 */
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite: "Strict" | "Lax" | "None" | null;
}

/**
 * The full cookie jar at one phase of a recon journey (e.g. post-click vs.
 * post-apply), so a run can show what each phase specifically established.
 * `error` is populated instead of `cookies` when the CDP call failed —
 * cookie telemetry is best-effort and must never abort the run.
 */
export interface CookieJarSnapshot {
  label: string;
  phase: string;
  stepIndex: number;
  timestamp: string;
  cookies: CookieRecord[];
  error?: string;
}

export interface ReplayResult {
  sourceCapture: string;
  url: string;
  method: string;
  operationName: string | null;
  requestBody: string | null;
  replayStatus: number | null;
  replayHeaders: Record<string, string>;
  replayBody: unknown;
  success: boolean;
  error: string | null;
  /** True when the replay response's key shape differs from the browser capture. */
  shapeDiffers?: boolean;
  /** Captured request headers that the replay did not send (possible load-bearing headers). */
  omittedCaptureHeaders?: string[];
  /**
   * Of the omitted headers (as captured), those proven by re-replay to restore the
   * capture's response shape. Empty when re-sending them does not restore it.
   */
  shapeRestoringHeaders?: string[];
  /** On a 401: the outcome of re-replaying with the captured authorization header. */
  authReplay?: {
    status: number;
    /** True when the authorization-carrying retry returned 2xx (needs-token, not needs-browser). */
    tokenReplayable: boolean;
    /** Which captured HTML document carries the bearer value, when found. */
    tokenSource: { document: number; source: "rsc-row" | "html"; row?: string } | null;
  };
}

export interface RateLimitFinding {
  endpoint: string;
  safeRps: number | null;
  triggerStatus: number | null;
  triggerRps: number | null;
  retryAfter: string | null;
  xRateLimitHeaders: Record<string, string>;
}

/** Leading numeric counter of a capture filename (`148-...` → 148), or null. */
function captureCounter(filename: string): number | null {
  const m = /^(\d+)/.exec(filename);
  return m ? Number(m[1]) : null;
}

/**
 * Orders capture filenames by their numeric counter prefix (so `148-` precedes
 * `1177-`, which a lexical sort inverts once the counter outgrows its padding),
 * falling back to lexical order for ties and counter-less names.
 */
export function compareCaptureFilenames(a: string, b: string): number {
  const na = captureCounter(a);
  const nb = captureCounter(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readJsonDir<T>(dir: string, exclude: string[] = []): T[] {
  try {
    return readdirSync(dir)
      .filter((f) => isRawCaptureFilename(f) && !exclude.includes(f))
      .sort(compareCaptureFilenames)
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
  } catch {
    return [];
  }
}

/**
 * Reads a directory of capture JSON files and coerces `query`/`operationName`
 * to `null` whenever the on-disk value isn't a string, so archives written by
 * a prior version (or hand-edited) can't hand a non-string into code that
 * assumes the declared `Capture` shape.
 */
export function readCaptureDir(dir: string, exclude: string[] = []): Capture[] {
  return readJsonDir<Capture>(dir, exclude).map((capture) => ({
    ...capture,
    query: typeof capture.query === "string" ? capture.query : null,
    operationName: typeof capture.operationName === "string" ? capture.operationName : null,
  }));
}

/**
 * Reads just `successUrlFragments` out of a recon flow file.
 *
 * Why a separate reader rather than reusing recon-browser's `parseReconFlow`:
 * that parser exits the process on a malformed flow file, which is right for a
 * recon run but wrong for the replay driver — a bad flow file must not abort a
 * sweep over a field that only decorates the report. Returns `[]` for the legacy
 * bare-array flow shape, and `[]` (with a warning) on any read/parse failure.
 */
export function readSuccessUrlFragments(flowFile: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
    if (Array.isArray(parsed)) return [];
    const fragments = (parsed as { successUrlFragments?: unknown }).successUrlFragments;
    if (!Array.isArray(fragments)) return [];
    return fragments.filter((f): f is string => typeof f === "string" && f.length > 0);
  } catch (err) {
    logger.warn(
      `flow file '${flowFile}' unreadable for successUrlFragments, terminal-URL detection disabled: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/**
 * Reads just `ownBackendHostnames` out of a recon flow file.
 *
 * Mirrors `readSuccessUrlFragments` above: tolerant of a missing/malformed
 * file (a bad flow file must not abort the HTTP probe over a field that only
 * narrows a filter), and returns `[]` for the legacy bare-array flow shape.
 */
export function readOwnBackendHostnames(flowFile: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
    if (Array.isArray(parsed)) return [];
    const hostnames = (parsed as { ownBackendHostnames?: unknown }).ownBackendHostnames;
    if (!Array.isArray(hostnames)) return [];
    return hostnames.filter((h): h is string => typeof h === "string" && h.length > 0);
  } catch (err) {
    logger.warn(
      `flow file '${flowFile}' unreadable for ownBackendHostnames, aux-fixture allowlist disabled: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/**
 * One caller-supplied payload field the generator adds beyond the recorded
 * form fields. `sensitive` fields must be strings: the engine registers only
 * string values for PII scrubbing.
 */
export const EXTRA_PAYLOAD_FIELD_SCHEMA = z
  .object({
    name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "name must be a valid JS identifier"),
    type: z.enum(["string", "number", "boolean"]).default("string"),
    optional: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    /** How a sensitive value is matched in output: by digits (phone/ids) or as a word. Defaults to `word`. */
    redactionKind: z.enum(["digit", "word"]).optional(),
  })
  .refine((f) => !f.sensitive || f.type === "string", {
    message: "a sensitive extraPayloadField must be string-typed",
    path: ["type"],
  });

export type ExtraPayloadField = z.infer<typeof EXTRA_PAYLOAD_FIELD_SCHEMA>;

/**
 * The `meta.redaction` policy for the sensitive declared fields, or null when
 * none is sensitive (so a flow without them emits nothing). The key kind comes
 * from the declared `redactionKind`, never from the field name.
 */
export function buildExtraFieldRedaction(
  fields: readonly ExtraPayloadField[]
): { wordKeys?: string[]; digitKeys?: string[] } | null {
  const wordKeys = fields
    .filter((f) => f.sensitive && f.redactionKind !== "digit")
    .map((f) => f.name);
  const digitKeys = fields
    .filter((f) => f.sensitive && f.redactionKind === "digit")
    .map((f) => f.name);
  if (wordKeys.length === 0 && digitKeys.length === 0) return null;
  return {
    ...(wordKeys.length > 0 && { wordKeys }),
    ...(digitKeys.length > 0 && { digitKeys }),
  };
}

/**
 * Reads and validates `extraPayloadFields` from a recon flow file.
 * Tolerant like `readOwnBackendHostnames`: `[]` for bare-array flows, a
 * missing/unreadable file or an absent key; an invalid declaration throws.
 */
export function readExtraPayloadFields(flowFile: string): ExtraPayloadField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(flowFile, "utf8"));
  } catch (err) {
    logger.warn(
      `flow file '${flowFile}' unreadable for extraPayloadFields: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") return [];
  const raw = (parsed as { extraPayloadFields?: unknown }).extraPayloadFields;
  if (raw === undefined) return [];
  const result = z.array(EXTRA_PAYLOAD_FIELD_SCHEMA).safeParse(raw);
  if (!result.success) {
    throw new Error(
      `flow file '${flowFile}' has invalid extraPayloadFields: ${result.error.message}`
    );
  }
  return result.data;
}

/**
 * Reads the flow file's declared endpoint patterns: `submitEndpointPattern`
 * first, then every `foldReturn` `endpointPattern` (single object or array).
 * Tolerant like `readOwnBackendHostnames`: `[]` for bare-array flows and on
 * read/parse failure.
 */
export function readDeclaredEndpointPatterns(flowFile: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") return [];
    const { submitEndpointPattern, foldReturn } = parsed as {
      submitEndpointPattern?: unknown;
      foldReturn?: unknown;
    };
    const out: string[] = [];
    const add = (v: unknown): void => {
      if (typeof v === "string" && v.length > 0) out.push(v);
    };
    add(submitEndpointPattern);
    const folds = Array.isArray(foldReturn) ? foldReturn : foldReturn ? [foldReturn] : [];
    for (const f of folds) {
      if (f && typeof f === "object") add((f as { endpointPattern?: unknown }).endpointPattern);
    }
    return out;
  } catch (err) {
    logger.warn(
      `flow file '${flowFile}' unreadable for declared endpoint patterns, relevance ordering disabled: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

/** Reads the flow file's `submitEndpointPattern` alone (undefined when absent/unreadable). */
export function readSubmitEndpointPattern(flowFile: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") return undefined;
    const v = (parsed as { submitEndpointPattern?: unknown }).submitEndpointPattern;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the explicit top-level `browserFlowOnly` opt-in out of a recon flow file.
 *
 * Throws on an unreadable or malformed file so a broken flow is reported rather
 * than silently treated as not opted in. Tolerates the legacy bare-array shape;
 * only a literal `true` opts in.
 */
export function readBrowserFlowOnly(flowFile: string): boolean {
  const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
  if (Array.isArray(parsed)) return false;
  return (parsed as { browserFlowOnly?: unknown } | null)?.browserFlowOnly === true;
}

/** Mixed-flow declaration: `actions` HTTP-replayed steps, captures tailed from `tailFromStep`. */
export interface HttpStepsOption {
  actions: number;
  tailFromStep: number;
  handoverUrl?: string;
}

/**
 * Reads the top-level `httpSteps` option out of a recon flow file. Null when
 * absent, legacy bare-array, or invalid in shape. Throws on an unreadable or
 * malformed file, and when combined with `browserFlowOnly: true`.
 */
export function readHttpSteps(flowFile: string): HttpStepsOption | null {
  const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") return null;
  const { httpSteps: v, browserFlowOnly } = parsed as {
    httpSteps?: unknown;
    browserFlowOnly?: unknown;
  };
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const { actions, tailFromStep, handoverUrl } = v as Record<string, unknown>;
  if (typeof actions !== "number" || !Number.isInteger(actions) || actions < 1) return null;
  if (typeof tailFromStep !== "number" || !Number.isInteger(tailFromStep) || tailFromStep < 0)
    return null;
  if (handoverUrl !== undefined && typeof handoverUrl !== "string") return null;
  if (browserFlowOnly === true) {
    throw new Error(
      "Flow file declares both httpSteps and browserFlowOnly:true; they are mutually exclusive"
    );
  }
  return handoverUrl === undefined
    ? { actions, tailFromStep }
    : { actions, tailFromStep, handoverUrl };
}

/**
 * Reads the explicit top-level `applicantContract` declaration out of a recon
 * flow file: true/false when declared as a boolean, undefined when absent,
 * non-boolean, or the legacy bare-array shape.
 */
export function readApplicantContract(flowFile: string): boolean | undefined {
  const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
  if (Array.isArray(parsed)) return undefined;
  const v = (parsed as { applicantContract?: unknown } | null)?.applicantContract;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Resolves the flow file's retry declaration to one number: `irreversible: true`
 * yields 1, else a valid declared `maxAttempts` (positive integer), else null.
 * When both are declared the smaller wins. Null on absent/invalid/legacy-array/unreadable.
 */
export function readDeclaredMaxAttempts(flowFile: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") return null;
    const { maxAttempts, irreversible } = parsed as {
      maxAttempts?: unknown;
      irreversible?: unknown;
    };
    const declared =
      typeof maxAttempts === "number" && Number.isInteger(maxAttempts) && maxAttempts > 0
        ? maxAttempts
        : null;
    if (irreversible === true) return declared === null ? 1 : Math.min(1, declared);
    return declared;
  } catch {
    return null;
  }
}

/** True when the replay got a 2xx response, whether or not its shape matched the capture. */
export function replayReachable(r: ReplayResult): boolean {
  return r.replayStatus !== null && r.replayStatus >= 200 && r.replayStatus < 300;
}

/** A replay passes only when its status was ok AND its response shape matches the capture. */
export function replayPassed(r: ReplayResult): boolean {
  return r.success && !r.shapeDiffers;
}

/**
 * Request headers that carry a credential or a cache conditional: their captured
 * value belongs to one recon session (a token, a cookie jar, a stale ETag or
 * date), so generated code never freezes one into BASE_HEADERS, even when
 * re-replay proves it load-bearing; it must be obtained per call.
 */
export const CREDENTIAL_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "if-none-match",
  "if-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
]);

/**
 * Counts, per captured request header (lowercased), how many shape-diverging
 * replays it restored when re-sent (`shapeRestoringHeaders`): the request headers
 * re-replay proved load-bearing.
 */
export function tallyShapeRestoringHeaders(replays: ReplayResult[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const replay of replays) {
    if (!replay.shapeDiffers) continue;
    for (const header of new Set(
      (replay.shapeRestoringHeaders ?? []).map((h) => h.toLowerCase())
    )) {
      counts.set(header, (counts.get(header) ?? 0) + 1);
    }
  }
  return counts;
}
