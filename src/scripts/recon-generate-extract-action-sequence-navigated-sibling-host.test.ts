import { describe, expect, it } from "vitest";

import { extractActionSequence } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const DOMAIN = "navigated-sibling-fixture.example.com";
const PRIMARY = `www.${DOMAIN}`;
const SIBLING = `pay.${DOMAIN}`;

const cap = (method: string, url: string, responseBody: unknown = {}): Capture => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method,
  url,
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: method === "GET" ? null : "{}",
  responseHeaders: {},
  responseBody,
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

const run = (captures: Capture[]) =>
  extractActionSequence(
    captures,
    { endpoint: "checkout/submit", body: null },
    null,
    [PRIMARY, SIBLING],
    DOMAIN,
    true,
    PRIMARY
  ).map((a) => a.capture.url);

describe("extractActionSequence — navigated sibling hosts", () => {
  it("keeps POSTs to a sibling host reached via a form action", () => {
    const page = cap("GET", `https://${PRIMARY}/checkout`, `<form action="https://${SIBLING}/pay/start"></form>`);
    const first = cap("POST", `https://${PRIMARY}/checkout/submit`);
    const second = cap("POST", `https://${SIBLING}/checkout/submit`);
    expect(run([page, first, second])).toEqual([first.url, second.url]);
  });

  it("still gates a sibling host the flow never navigated to", () => {
    const first = cap("POST", `https://${PRIMARY}/checkout/submit`);
    const second = cap("POST", `https://${SIBLING}/checkout/submit`);
    expect(run([first, second])).toEqual([first.url]);
  });

  it("still gates an unrelated registrable domain even if navigated", () => {
    const page = cap("GET", `https://${PRIMARY}/checkout`, `<iframe src="https://ads.other-site.example.org/x"></iframe>`);
    const first = cap("POST", `https://${PRIMARY}/checkout/submit`);
    const other = cap("POST", `https://ads.other-site.example.org/checkout/submit`);
    expect(run([page, first, other])).toEqual([first.url]);
  });
});
