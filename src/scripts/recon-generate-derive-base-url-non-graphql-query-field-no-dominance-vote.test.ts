import { describe, expect, it } from "vitest";

import { deriveBaseUrl } from "@/scripts/recon-generate";

const capture = (url: string, timestamp: string, query: string | null = null) => ({
  timestamp,
  phase: "action" as const,
  method: "GET",
  url,
  status: 200,
  requestHeaders: {},
  requestPostData: null,
  responseHeaders: {},
  responseBody: {},
  operationName: null,
  query,
  variables: null,
  decodedParams: null,
});

describe("deriveBaseUrl — sameDomainHasGraphql requires a parsed GraphQL operation, not merely a non-empty `.query` (#bugfix-002)", () => {
  it("does not trigger the dominance vote when the anchor host's same-domain pool's only query-bearing capture is non-GraphQL text", () => {
    const anchor = capture(
      "https://api.fictional-widgets.test/search",
      "2024-01-01T00:00:00Z",
      "q=stapler&sort=relevance"
    );
    const majoritySiblingSubdomain = Array.from({ length: 5 }, (_, i) =>
      capture(`https://accounts.fictional-widgets.test/${i}`, `2024-01-01T00:00:0${i + 1}Z`)
    );

    const withQueryText = deriveBaseUrl([anchor, ...majoritySiblingSubdomain], []);
    const withoutQueryField = deriveBaseUrl(
      [{ ...anchor, query: null }, ...majoritySiblingSubdomain],
      []
    );

    expect(withQueryText).toBe("https://api.fictional-widgets.test");
    expect(withQueryText).toBe(withoutQueryField);
  });

  it("still runs the dominance vote when a same-domain capture's `.query` parses as a genuine GraphQL operation", () => {
    const anchor = capture(
      "https://api.fictional-widgets.test/graphql",
      "2024-01-01T00:00:00Z",
      "query FetchWidget { widget { id } }"
    );
    const majoritySiblingSubdomain = Array.from({ length: 5 }, (_, i) =>
      capture(`https://accounts.fictional-widgets.test/${i}`, `2024-01-01T00:00:0${i + 1}Z`)
    );

    const baseUrl = deriveBaseUrl([anchor, ...majoritySiblingSubdomain], []);

    expect(baseUrl).toBe("https://accounts.fictional-widgets.test");
  });
});
