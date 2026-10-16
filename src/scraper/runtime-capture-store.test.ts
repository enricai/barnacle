import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
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

function makeCapture(method: string): Capture {
  return {
    timestamp: "t",
    phase: "p",
    method,
    url: "https://example.com/x",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

describe("runtime capture store", () => {
  it("lists and reads recorded captures via the default dir", () => {
    withRuntimeCaptureStore(() => {
      recordRuntimeCapture("1-a.json", makeCapture("POST"));
      const dir = defaultCapturesDir();
      expect(listCaptureFiles(dir)).toEqual(["1-a.json"]);
      expect(readCaptureFile(dir, "1-a.json")?.responseBody).toEqual({ ok: true });
    });
  });

  it("isolates concurrent scopes", async () => {
    const seen = await Promise.all([
      withRuntimeCaptureStore(async () => {
        recordRuntimeCapture("1-a.json", makeCapture("POST"));
        await new Promise((r) => setTimeout(r, 5));
        return listCaptureFiles(defaultCapturesDir());
      }),
      withRuntimeCaptureStore(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return listCaptureFiles(defaultCapturesDir());
      }),
    ]);
    expect(seen).toEqual([["1-a.json"], []]);
  });

  it("drops GET response bodies", () => {
    withRuntimeCaptureStore(() => {
      recordRuntimeCapture("1-g.json", makeCapture("GET"));
      expect(readCaptureFile(defaultCapturesDir(), "1-g.json")?.responseBody).toBeNull();
    });
  });

  it("evicts the oldest past the cap", () => {
    withRuntimeCaptureStore(() => {
      for (let i = 0; i <= RUNTIME_CAPTURE_LIMIT; i++) {
        recordRuntimeCapture(`${i}-a.json`, makeCapture("POST"));
      }
      const files = listCaptureFiles(defaultCapturesDir());
      expect(files).toHaveLength(RUNTIME_CAPTURE_LIMIT);
      expect(files).not.toContain("0-a.json");
    });
  });

  it("falls through to recon dir and disk outside a scope", () => {
    expect(defaultCapturesDir()).toBe(resolveReconRunDir().graphqlDir);
    const dir = mkdtempSync(join(tmpdir(), "caps-"));
    writeFileSync(join(dir, "1-a.json"), JSON.stringify(makeCapture("POST")));
    writeFileSync(join(dir, "1-a.decoded.json"), "{}");
    expect(listCaptureFiles(dir)).toEqual(["1-a.json"]);
    expect(readCaptureFile(dir, "1-a.json")?.method).toBe("POST");
    expect(readCaptureFile(dir, "missing.json")).toBeNull();
  });
});
