import { describe, expect, it } from "vitest";
import {
  checkFrameDocumentIdentity,
  readFrameDocumentIdentity,
} from "./frame-document-identity.js";

const ok = (v: unknown) => ({ evaluate: async () => v as never });
const bad = {
  evaluate: async () => {
    throw new Error("detached");
  },
};

describe("frame document identity", () => {
  it("same identity -> current", async () => {
    expect(await checkFrameDocumentIdentity(ok(5), 5)).toBe("current");
  });
  it("different identity -> replaced", async () => {
    expect(await checkFrameDocumentIdentity(ok(6), 5)).toBe("replaced");
  });
  it("read failure / null is unknown, not replaced", async () => {
    expect(await checkFrameDocumentIdentity(bad, 5)).toBe("unknown");
    expect(await checkFrameDocumentIdentity(ok(null), 5)).toBe("unknown");
    expect(await checkFrameDocumentIdentity(ok(5), null)).toBe("unknown");
  });
  it("read returns null on failure", async () => {
    expect(await readFrameDocumentIdentity(bad)).toBeNull();
    expect(await readFrameDocumentIdentity(ok(Number.NaN))).toBeNull();
  });
});
