import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeCaptureFiles } from "@/scripts/recon-browser";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeCaptureFiles decoded sidecar", () => {
  it("writes string decodedParams as .decoded.txt, no .decoded.json", () => {
    dir = mkdtempSync(join(tmpdir(), "sidecar-"));
    const text = "id=1&ev=View&dl=https://example.com/";
    writeCaptureFiles(dir, { decodedParams: text, requestPostData: "id%3D1" }, "0001.json");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["0001.decoded.txt", "0001.json"]);
    expect(readFileSync(join(dir, "0001.decoded.txt"), "utf8")).toBe(text);
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      JSON.parse(readFileSync(join(dir, f), "utf8"));
    }
  });

  it("writes object decodedParams as parseable .decoded.json", () => {
    dir = mkdtempSync(join(tmpdir(), "sidecar-"));
    writeCaptureFiles(dir, { decodedParams: { a: 1 }, requestPostData: "x" }, "0002.json");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["0002.decoded.json", "0002.json"]);
    for (const f of files) JSON.parse(readFileSync(join(dir, f), "utf8"));
  });
});
