import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capture } from "@/scripts/recon-shared";
import { resolveReconRunDir } from "@/scripts/recon-shared";

/** Upper bound on captures held per run so a long-lived session cannot grow without limit. */
export const RUNTIME_CAPTURE_LIMIT = 200;

const MEMORY_DIR_PREFIX = "memory:";

/** Handle to a run's in-memory captures, passed explicitly so writes never depend on the async context. */
export interface RuntimeCaptureStore {
  dir: string;
  captures: Map<string, Capture>;
}

const storage = new AsyncLocalStorage<RuntimeCaptureStore>();
const registry = new Map<string, RuntimeCaptureStore>();

/**
 * Runs `fn` with a private in-memory capture store so runtime flows can feed
 * the same window detectors recon uses without touching disk. The store handle
 * is passed to `fn` and registered by its dir marker until the run settles, so
 * captures delivered from any async context land in the right run's store.
 */
export function withRuntimeCaptureStore<T>(fn: (store: RuntimeCaptureStore) => T): T {
  const store: RuntimeCaptureStore = {
    dir: `${MEMORY_DIR_PREFIX}${randomUUID()}`,
    captures: new Map(),
  };
  registry.set(store.dir, store);
  const release = (): void => {
    registry.delete(store.dir);
  };
  try {
    const result = storage.run(store, () => fn(store));
    if (result instanceof Promise) {
      result.then(release, release);
      return result;
    }
    release();
    return result;
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Records a capture into `store`. GET response bodies are dropped — they are
 * static assets and prefetches, not action signals — and the oldest entries
 * are evicted past {@link RUNTIME_CAPTURE_LIMIT}.
 */
export function recordRuntimeCapture(
  store: RuntimeCaptureStore,
  filename: string,
  capture: Capture
): void {
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
  return registry.get(dir) ?? null;
}

/**
 * Lists raw capture filenames in `dir` (excluding `.decoded.json` sidecars),
 * from memory when `dir` is a live runtime store, else from disk. Returns []
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
