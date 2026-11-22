import { describe, expect, it } from "vitest";

import { extractActionSequence } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const DOMAIN = "form-submit-fixture.example";
const URL_ = `https://www.${DOMAIN}/wizard/step?flow=1`;

const mk = (body: string, status: number, reqType: string, respType: string | null): Capture => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url: URL_,
  status,
  requestHeaders: { "Content-Type": reqType },
  requestPostData: body,
  responseHeaders: respType ? { "Content-Type": respType } : {},
  responseBody: null,
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

const run = (caps: Capture[]) =>
  extractActionSequence(caps, { endpoint: "wizard/step", body: null }, null, [], DOMAIN).map(
    (a) => a.capture
  );

const U = "application/x-www-form-urlencoded";

describe("extractActionSequence — server-rendered form submits", () => {
  it("keeps 302 and final 200 html form posts", () => {
    const caps = [
      mk("a=1", 302, U, null),
      mk("--x\r\nb=2", 302, "multipart/form-data; boundary=x", null),
      mk("c=3", 200, U, "text/html"),
    ];
    expect(run(caps).map((c) => c.requestPostData)).toEqual(caps.map((c) => c.requestPostData));
  });
  it("drops 302 JSON post and 404 form post", () => {
    expect(run([mk("{}", 302, "application/json", null)])).toEqual([]);
    expect(run([mk("a=1", 404, U, "text/html")])).toEqual([]);
  });
});
