import { describe, expect, it } from "vitest";
import { filterManifestByDeclaredSubmit } from "./recon-generate";

const mk = (i: number, body: string) =>
  ({
    capture: { url: "https://x.test/api", method: "POST", requestPostData: body, status: 200 },
    index: i,
  }) as never;

describe("filterManifestByDeclaredSubmit", () => {
  const manifest = [
    ...Array.from({ length: 13 }, (_, i) =>
      mk(i, i === 12 ? '{"op":"submit"}' : '{"op":"chrome"}')
    ),
  ];
  it("keeps only captures matching the declared body pattern", () => {
    const out = filterManifestByDeclaredSubmit(manifest, {
      endpoint: null,
      body: "submit",
    } as never);
    expect(out).toHaveLength(1);
  });
  it("returns manifest unchanged without a declared pattern", () => {
    expect(filterManifestByDeclaredSubmit(manifest, null)).toBe(manifest);
    expect(filterManifestByDeclaredSubmit(manifest, { endpoint: null, body: null } as never)).toBe(
      manifest
    );
  });
  it("falls back when the pattern matches nothing", () => {
    expect(filterManifestByDeclaredSubmit(manifest, { endpoint: null, body: "zzz" } as never)).toBe(
      manifest
    );
  });
});
