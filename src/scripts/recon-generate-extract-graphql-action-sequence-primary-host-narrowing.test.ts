import { describe, expect, it } from "vitest";

import { extractGraphQLActionSequence, type SubmitPatterns } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the GraphQL-branch counterpart to `extractActionSequence`'s
 * `primaryHost` narrowing: `isAllowedFixtureHost` already accepts any
 * `fallbackDomain`-registrable host once `ownBackendHostnames` is empty, so
 * a minority subdomain of the flow's own registrable domain (e.g. a CDN or
 * staging host under the same domain) passes host-provenance gating
 * alongside the real primary host. Without `primaryHost` narrowing, that
 * minority-host noise — a same-shape GraphQL mutation matching the declared
 * `submitEndpointPattern` — is admitted into the action sequence right next
 * to the genuine primary-host operations, corrupting the state-threaded
 * submit/fold sequence a generated plugin replays.
 */

const REGISTRABLE_DOMAIN = "example.com";
const PRIMARY_HOST = "api.example.com";
const MINORITY_SUBDOMAIN = "cdn.example.com";

const SUBMIT_PATTERNS: SubmitPatterns = {
  endpoint: "/graphql",
  body: null,
};

function graphqlCapture(
  host: string,
  timestamp: string,
  operationName: string,
  submissionId: string
): Capture {
  return {
    timestamp,
    phase: "action",
    method: "POST",
    url: `https://${host}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName }),
    responseHeaders: {},
    operationName,
    query: `mutation ${operationName}($input: Input) {\n  ${operationName}(input: $input) { id }\n}`,
    variables: null,
    responseBody: { submissionId },
    decodedParams: null,
  };
}

describe("extractGraphQLActionSequence — primaryHost narrowing excludes same-registrable-domain minority-host noise", () => {
  it("drops minority-subdomain GraphQL noise and keeps the primary-host operations, in order, when primaryHost is passed", () => {
    const primaryFirst = graphqlCapture(
      PRIMARY_HOST,
      "2026-01-01T00:00:00.000Z",
      "CreateApplication",
      "sub-1"
    );
    const minorityNoise = graphqlCapture(
      MINORITY_SUBDOMAIN,
      "2026-01-01T00:00:30.000Z",
      "CreateApplication",
      "sub-noise"
    );
    const primarySecond = graphqlCapture(
      PRIMARY_HOST,
      "2026-01-01T00:01:00.000Z",
      "SubmitApplication",
      "sub-1"
    );

    const kept = extractGraphQLActionSequence(
      [primaryFirst, minorityNoise, primarySecond],
      SUBMIT_PATTERNS,
      null,
      [],
      REGISTRABLE_DOMAIN,
      PRIMARY_HOST
    );

    expect(kept.map((a) => a.capture.url)).toEqual([
      `https://${PRIMARY_HOST}/graphql`,
      `https://${PRIMARY_HOST}/graphql`,
    ]);
    expect(kept.map((a) => a.capture.operationName)).toEqual([
      "CreateApplication",
      "SubmitApplication",
    ]);
  });

  it("preserves current unnarrowed behavior — admits the minority-host capture too — when primaryHost is omitted", () => {
    const primaryFirst = graphqlCapture(
      PRIMARY_HOST,
      "2026-01-01T00:00:00.000Z",
      "CreateApplication",
      "sub-1"
    );
    const minorityNoise = graphqlCapture(
      MINORITY_SUBDOMAIN,
      "2026-01-01T00:00:30.000Z",
      "CreateApplication",
      "sub-noise"
    );

    const kept = extractGraphQLActionSequence(
      [primaryFirst, minorityNoise],
      SUBMIT_PATTERNS,
      null,
      [],
      REGISTRABLE_DOMAIN
    );

    expect(kept.map((a) => a.capture.url)).toEqual([
      `https://${PRIMARY_HOST}/graphql`,
      `https://${MINORITY_SUBDOMAIN}/graphql`,
    ]);
  });
});
