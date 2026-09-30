import { describe, expect, it } from "vitest";

import { extractActionSequence } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the `extractActionSequence` bypass site behind the report's
 * "0 capture(s)" symptom: with only `fallbackDomain` (no `ownBackendHostnames`
 * allowlist), an undeclared subdomain sharing the same registrable domain as
 * the real backend passes `isAllowedFixtureHost` just as validly as the
 * primary host does. If that subdomain's noise coincidentally matches the
 * declared `submitEndpointPattern`, it can starve out the real primary-host
 * submission unless `primaryHost` narrows the pool to the dominant host.
 */

const FALLBACK_DOMAIN = "tenant-primary-host-fixture.example";
const PRIMARY_HOST = `www.${FALLBACK_DOMAIN}`;
const UNDECLARED_SUBDOMAIN = `beta.${FALLBACK_DOMAIN}`;

const capture = (url: string, body: string): Capture => ({
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "POST",
  url,
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: body,
  responseHeaders: {},
  responseBody: {},
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
});

describe("extractActionSequence — primaryHost narrowing against undeclared-subdomain noise sharing fallbackDomain", () => {
  it("returns the real primary-host submission and excludes undeclared-subdomain noise matching the same pattern", () => {
    const realSubmit = capture(`https://${PRIMARY_HOST}/checkout/submit`, "{}");
    // A staging/beta subdomain nobody declared, but which shares the same
    // registrable domain, so fallbackDomain-only gating alone admits it.
    const subdomainNoise = Array.from({ length: 5 }, (_unused, index) =>
      capture(`https://${UNDECLARED_SUBDOMAIN}/checkout/submit-preview-${index}`, "{}")
    );

    const kept = extractActionSequence(
      [...subdomainNoise, realSubmit],
      { endpoint: "checkout/submit", body: null },
      null,
      [],
      FALLBACK_DOMAIN,
      true,
      PRIMARY_HOST
    ).map((a) => a.capture.url);

    expect(kept).toEqual([realSubmit.url]);
  });

  it("keeps today's behavior for callers that omit primaryHost — both same-registrable-domain hosts pass gating", () => {
    const primarySubmit = capture(`https://${PRIMARY_HOST}/checkout/submit`, "{}");
    const subdomainSubmit = capture(`https://${UNDECLARED_SUBDOMAIN}/checkout/submit`, "{}");

    const kept = extractActionSequence(
      [primarySubmit, subdomainSubmit],
      { endpoint: "checkout/submit", body: null },
      null,
      [],
      FALLBACK_DOMAIN
    ).map((a) => a.capture.url);

    expect(kept).toEqual([primarySubmit.url, subdomainSubmit.url]);
  });
});
