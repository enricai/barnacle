import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CookieJarSnapshot } from "@/scripts/recon-shared";
import { COOKIES_DIR } from "@/scripts/recon-shared";

const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

let tmpDir: string | null = null;

/** Re-imports recon-shared fresh so its module-level memoization doesn't leak across cases. */
async function loadResolver() {
  vi.resetModules();
  return import("@/scripts/recon-shared.js");
}

afterEach(() => {
  delete process.env.RECON_RUN_ID;
  delete process.env.RECON_OUT_DIR;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("COOKIES_DIR", () => {
  it("points at the recon cookies directory", () => {
    expect(COOKIES_DIR).toBe("/tmp/recon/cookies");
  });
});

describe("CookieJarSnapshot shape", () => {
  it("typechecks a full jar snapshot literal", () => {
    const snapshot: CookieJarSnapshot = {
      label: "post-click",
      phase: "click",
      stepIndex: 0,
      timestamp: "2026-07-18T00:00:00.000Z",
      cookies: [
        {
          name: "appcast_session",
          value: "abc123",
          domain: ".appcast.io",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
          expires: -1,
          session: true,
          size: 17,
        },
      ],
    };

    const [cookie] = snapshot.cookies;
    expect(snapshot.cookies).toHaveLength(1);
    expect(cookie?.sameSite).toBe("Lax");
  });
});

describe("resolveReconRunDir", () => {
  it("produces different run roots across two unseeded resolutions", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-shared-test-"));
    process.env.RECON_OUT_DIR = tmpDir;

    const { resolveReconRunDir: resolveFirst } = await loadResolver();
    const first = resolveFirst();

    const { resolveReconRunDir: resolveSecond } = await loadResolver();
    const second = resolveSecond();

    expect(first.root).not.toBe(second.root);
    expect(first.runId).not.toBe(second.runId);
  });

  it("yields a deterministic root when RECON_RUN_ID is set", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-shared-test-"));
    process.env.RECON_RUN_ID = "20260718-120326-fixd";
    process.env.RECON_OUT_DIR = tmpDir;

    const { resolveReconRunDir } = await loadResolver();
    const runDir = resolveReconRunDir();

    expect(runDir.runId).toBe("20260718-120326-fixd");
    expect(runDir.root).toBe(join(tmpDir, "20260718-120326-fixd"));
  });

  it("roots all five subdirs under RECON_OUT_DIR and creates them on disk", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-shared-test-"));
    process.env.RECON_OUT_DIR = tmpDir;

    const { resolveReconRunDir } = await loadResolver();
    const runDir = resolveReconRunDir();

    expect(runDir.graphqlDir).toBe(join(runDir.root, "graphql"));
    expect(runDir.cookiesDir).toBe(join(runDir.root, "cookies"));
    expect(runDir.replaysDir).toBe(join(runDir.root, "replays"));
    expect(runDir.auxDir).toBe(join(runDir.root, "aux"));
    expect(runDir.stepFailuresDir).toBe(join(runDir.root, "step-failures"));

    expect(existsSync(runDir.graphqlDir)).toBe(true);
    expect(existsSync(runDir.cookiesDir)).toBe(true);
    expect(existsSync(runDir.replaysDir)).toBe(true);
    expect(existsSync(runDir.auxDir)).toBe(true);
    expect(existsSync(runDir.stepFailuresDir)).toBe(true);
  });

  it("generates a runId matching the timestamp+suffix shape", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-shared-test-"));
    process.env.RECON_OUT_DIR = tmpDir;

    const { resolveReconRunDir } = await loadResolver();
    const runDir = resolveReconRunDir();

    expect(runDir.runId).toMatch(RUN_ID_PATTERN);
  });

  it("memoizes within one process so repeated calls return the identical root", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "recon-shared-test-"));
    process.env.RECON_OUT_DIR = tmpDir;

    const { resolveReconRunDir } = await loadResolver();
    const first = resolveReconRunDir();
    const second = resolveReconRunDir();

    expect(second).toBe(first);
    expect(second.root).toBe(first.root);
  });
});
