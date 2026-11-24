import { describe, expect, it } from "vitest";
import { extractActionSequence } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const HOST = "https://api.example.com";
const TOKEN = "tok_abcdef0123456789xyz";
const get = (path: string, body: unknown, t: number) =>
  buildCapture({
    url: `${HOST}${path}`,
    method: "GET",
    requestPostData: null,
    responseBody: body,
    timestamp: `2024-01-01T00:00:0${t}Z`,
  });
const paths = (caps: ReturnType<typeof get>[], submit: { endpoint: string; body: null }) =>
  extractActionSequence(caps, submit, null, [], "example.com", false, null).map(
    (a) => new URL(a.capture.url).pathname
  );

describe("GET token mint consumed by the declared read", () => {
  it("keeps the mint GET when the declared-read GET re-sends its token", () => {
    const caps = [
      get("/mint", { session: TOKEN }, 1),
      get(`/declared-read?s=${TOKEN}`, { rows: [] }, 2),
    ];
    expect(paths(caps, { endpoint: "/declared-read", body: null })).toContain("/mint");
  });

  it("drops the mint GET when the only later consumer is an undeclared GET", () => {
    const caps = [
      get("/mint", { session: TOKEN }, 1),
      get(`/other?s=${TOKEN}`, { rows: [] }, 2),
      get("/declared-read", { rows: [] }, 3),
    ];
    expect(paths(caps, { endpoint: "/declared-read", body: null })).not.toContain("/mint");
  });
});
