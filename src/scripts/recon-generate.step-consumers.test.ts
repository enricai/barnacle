import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  extractActionSequence,
  indexStateValues,
  stepFeedsDeclaredSubmit,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const TOKEN = "tok_Zk9qXv81T3mWb7LpR2dYc5Hn";
const TOKEN2 = "hdr_Qq8wXv81T3mWb7LpR2dYc5Hn";

function build() {
  const caps = [
    buildCapture({
      url: "https://a.example.com/mint",
      requestPostData: JSON.stringify({ a: 1 }),
      responseBody: { token: TOKEN },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildCapture({
      url: "https://a.example.com/relay",
      requestPostData: JSON.stringify({ token: TOKEN }),
      responseBody: { next: TOKEN2 },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildCapture({
      url: "https://a.example.com/submit",
      requestPostData: JSON.stringify({ x: 1 }),
      requestHeaders: { "X-Next": TOKEN2 },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:03Z",
    }),
    buildCapture({
      url: "https://a.example.com/beacon",
      requestPostData: JSON.stringify({ b: 1 }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:04Z",
    }),
  ];
  const seq = extractActionSequence(caps);
  const idx = new Set(seq.map((a) => a.index));
  const steps = compileActionSteps(seq, indexStateValues(caps, new Set(), idx));
  return { caps, steps };
}

describe("step consumers and declared-submit feed", () => {
  it("records consumers and follows them transitively", () => {
    const { caps, steps } = build();
    const [mint, relay, submit, beacon] = caps;
    const isSubmit = (c: unknown) => c === submit;
    const by = (c: unknown) => steps.find((s) => s.capture === c);
    expect(by(mint)?.consumers).toContain(relay);
    expect(by(relay)?.consumers).toContain(submit);
    expect(stepFeedsDeclaredSubmit(relay!, steps, isSubmit)).toBe(true);
    expect(stepFeedsDeclaredSubmit(mint!, steps, isSubmit)).toBe(true);
    expect(stepFeedsDeclaredSubmit(beacon!, steps, isSubmit)).toBe(false);
    expect(stepFeedsDeclaredSubmit(mint!, steps, () => false)).toBe(false);
  });
});
