import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.RECON_RUN_ID = "runtime-capture-store-test";
const RECON_TMP = mkdtempSync(join(tmpdir(), "recon-runtime-store-"));
process.env.RECON_OUT_DIR = RECON_TMP;

import {
  defaultCapturesDir,
  listCaptureFiles,
  RUNTIME_CAPTURE_LIMIT,
  readCaptureFile,
  recordRuntimeCapture,
  withRuntimeCaptureStore,
} from "@/scraper/runtime-capture-store";
import type { Capture } from "@/scripts/recon-shared";
import { resolveReconRunDir } from "@/scripts/recon-shared";

function makeCapture(method: string, url: string): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "test",
    method,
    url,
    status: 200,
    requestHeaders: {},
    requestPostData: method === "POST" ? '{"q":1}' : null,
    responseHeaders: {},
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe("runtime capture store", () => {
  afterAll(() => {
    rmSync(RECON_TMP, { recursive: true, force: true });
  });

  it("resolves the default dir to the recon dir outside a scope and the store inside", () => {
    expect(defaultCapturesDir()).toBe(resolveReconRunDir().graphqlDir);
    withRuntimeCaptureStore((store) => {
      const dir = defaultCapturesDir();
      expect(dir).not.toBe(resolveReconRunDir().graphqlDir);
      expect(dir.startsWith("memory:")).toBe(true);
    });
  });

  it("returns recorded captures through the reader", () => {
    withRuntimeCaptureStore((store) => {
      const dir = defaultCapturesDir();
      const capture = makeCapture("POST", "https://shop.example.com/api");
      recordRuntimeCapture(store, "a.json", capture);
      expect(listCaptureFiles(dir)).toEqual(["a.json"]);
      expect(readCaptureFile(dir, "a.json")).toEqual(capture);
      expect(readCaptureFile(dir, "missing.json")).toBeNull();
    });
  });

  it("is a no-op outside a scope", () => {
    recordRuntimeCapture(store, "x.json", makeCapture("POST", "https://shop.example.com/api"));
    expect(listCaptureFiles(defaultCapturesDir())).toEqual([]);
  });

  it("isolates overlapping scopes", async () => {
    const run = async (name: string, other: string): Promise<string[]> =>
      withRuntimeCaptureStore(async (store) => {
        const dir = defaultCapturesDir();
        recordRuntimeCapture(store, `${name}-1.json`, makeCapture("POST", "https://shop.example.com/1"));
        await tick();
        recordRuntimeCapture(store, `${name}-2.json`, makeCapture("POST", "https://shop.example.com/2"));
        await tick();
        expect(readCaptureFile(dir, `${other}-1.json`)).toBeNull();
        return listCaptureFiles(dir);
      });
    const [a, b] = await Promise.all([run("a", "b"), run("b", "a")]);
    expect(a).toEqual(["a-1.json", "a-2.json"]);
    expect(b).toEqual(["b-1.json", "b-2.json"]);
  });

  it("does not let a scope read another scope's dir", () => {
    const outerDir = withRuntimeCaptureStore((store) => {
      recordRuntimeCapture(store, "a.json", makeCapture("POST", "https://shop.example.com/api"));
      return defaultCapturesDir();
    });
    withRuntimeCaptureStore((store) => {
      expect(listCaptureFiles(outerDir)).toEqual([]);
    });
  });

  it("drops GET response bodies but keeps POST bodies", () => {
    withRuntimeCaptureStore((store) => {
      const dir = defaultCapturesDir();
      recordRuntimeCapture(store, "get.json", makeCapture("GET", "https://shop.example.com/asset"));
      recordRuntimeCapture(store, "post.json", makeCapture("POST", "https://shop.example.com/api"));
      expect(readCaptureFile(dir, "get.json")?.responseBody).toBeNull();
      expect(readCaptureFile(dir, "post.json")?.responseBody).toEqual({ ok: true });
    });
  });

  it("evicts the oldest captures past the limit", () => {
    withRuntimeCaptureStore((store) => {
      const dir = defaultCapturesDir();
      for (let i = 0; i < RUNTIME_CAPTURE_LIMIT + 5; i++) {
        recordRuntimeCapture(store, `c${i}.json`, makeCapture("POST", "https://shop.example.com/api"));
      }
      const files = listCaptureFiles(dir);
      expect(files).toHaveLength(RUNTIME_CAPTURE_LIMIT);
      expect(files[0]).toBe("c5.json");
      expect(readCaptureFile(dir, "c0.json")).toBeNull();
    });
  });

  it("reads from disk outside a scope, skipping decoded sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    writeFileSync(
      join(dir, "1-a.json"),
      JSON.stringify(makeCapture("POST", "https://shop.example.com/x"))
    );
    writeFileSync(join(dir, "1-a.decoded.json"), "{}");
    expect(listCaptureFiles(dir)).toEqual(["1-a.json"]);
    expect(readCaptureFile(dir, "1-a.json")?.method).toBe("POST");
    expect(readCaptureFile(dir, "missing.json")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing to disk", () => {
    withRuntimeCaptureStore((store) => {
      recordRuntimeCapture(store, "a.json", makeCapture("POST", "https://shop.example.com/api"));
    });
    const files = readdirSync(RECON_TMP, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile()
    );
    expect(files).toEqual([]);
  });
});
