import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capture } from "@/scripts/recon-shared";
import { resolveReconRunDir } from "@/scripts/recon-shared";

/** Upper bound on captures held per run so a long-lived session cannot grow without limit. */
export const RUNTIME_CAPTURE_LIMIT = 200;

const MEMORY_DIR_PREFIX = "memory:";

interface RuntimeCaptureStore {
  dir: string;
  captures: Map<string, Capture>;
}

const storage = new AsyncLocalStorage<RuntimeCaptureStore>();

/**
 * Runs `fn` with a private in-memory capture store so runtime flows can feed
 * the same window detectors recon uses without touching disk. The store is
 * bound to the async context, so concurrent runs never see each other's captures.
 */
export function withRuntimeCaptureStore<T>(fn: () => T): T {
  const store: RuntimeCaptureStore = {
    dir: `${MEMORY_DIR_PREFIX}${randomUUID()}`,
    captures: new Map(),
  };
  return storage.run(store, fn);
}

/**
 * Records a capture into the in-scope store (no-op outside one). GET response
 * bodies are dropped — they are static assets and prefetches, not action
 * signals — and the oldest entries are evicted past {@link RUNTIME_CAPTURE_LIMIT}.
 */
export function recordRuntimeCapture(filename: string, capture: Capture): void {
  const store = storage.getStore();
  if (!store) return;
  store.captures.set(
    filename,
    capture.method === "GET" ? { ...capture, responseBody: null } : capture
  );
  while (store.captures.size > RUNTIME_CAPTURE_LIMIT) {
    const oldest = store.captures.keys().next().value;
    if (oldest === undefined) return;
    store.captures.delete(oldest);
  }
}

/**
 * The directory capture readers should scan by default: the in-scope runtime
 * store's marker, else the recon run's on-disk graphql dir.
 */
export function defaultCapturesDir(): string {
  return storage.getStore()?.dir ?? resolveReconRunDir().graphqlDir;
}

function storeFor(dir: string): RuntimeCaptureStore | null {
  const store = storage.getStore();
  return store && store.dir === dir ? store : null;
}

/**
 * Lists raw capture filenames in `dir` (excluding `.decoded.json` sidecars),
 * from memory when `dir` is the in-scope store, else from disk. Returns []
 * when the dir is unreadable.
 */
export function listCaptureFiles(dir: string): string[] {
  const store = storeFor(dir);
  if (store) return [...store.captures.keys()];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".decoded.json"));
  } catch {
    return [];
  }
}

/**
 * Shared capture reader so detectors behave identically whether captures live
 * in memory (runtime) or on disk (recon). Returns null when absent or unparseable.
 */
export function readCaptureFile(dir: string, filename: string): Capture | null {
  const store = storeFor(dir);
  if (store) return store.captures.get(filename) ?? null;
  try {
    return JSON.parse(readFileSync(join(dir, filename), "utf8")) as Capture;
  } catch {
    return null;
  }
}
