import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeSubmitManifest } from "@/scripts/recon-browser";
import { resolveManifestActionSequence } from "@/scripts/recon-generate";
import { type Capture, readJsonDir } from "@/scripts/recon-shared";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never;
const URL_OF = (n: string) => `https://x.test/${n}`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "manifest-rt-"));
  const dir = join(root, "graphql");
  mkdirSync(dir);
  // Lexical order (1177, 148, 149) differs from numeric (148, 149, 1177).
  for (const [f, n, method] of [
    ["148-a.json", "widgets", "GET"],
    ["149-b.json", "widgets", "GET"],
    ["1177-z.json", "applySubmit", "POST"],
  ] as const)
    writeFileSync(
      join(dir, f),
      JSON.stringify({ url: URL_OF(n), method, status: 200, query: null, operationName: null })
    );
  writeSubmitManifest({
    runRoot: root,
    capturesDir: dir,
    submitEndpointPattern: "applySubmit",
    submitBodyPattern: null,
    logger: logger(),
  });
  return { root, dir };
}

describe("submit-manifest writer -> reader round trip", () => {
  it("resolves the written entry to the right capture despite lexical vs numeric order", () => {
    const { root, dir } = setup();
    const captures = readJsonDir<Capture>(dir);
    const resolved = resolveManifestActionSequence(root, captures);
    expect(resolved!.map((a) => a.index)).toEqual([2]);
    expect(resolved![0]!.capture.url).toBe(URL_OF("applySubmit"));
  });

  it("falls back to the recorded index when graphql/ is unreadable", () => {
    const { root, dir } = setup();
    const captures = readJsonDir<Capture>(dir);
    // Remove the dir so readdirSync throws in the reader; the recorded (lexical) index 0
    // then points at a widgets capture and the url guard rejects it.
    rmSync(dir, { recursive: true });
    expect(resolveManifestActionSequence(root, captures)).toBeNull();
  });
});
