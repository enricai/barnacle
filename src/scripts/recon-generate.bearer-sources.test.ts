import { describe, expect, it } from "vitest";

import { deriveReadFlowBearer, locateBearerSources } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { ReplayResult } from "@/scripts/recon-shared";

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (tokenType: string): string => `eyJhbGciOiJIUzI1NiJ9.${b64({ tokenType })}.sigsigsig`;
const call = (url: string, tokenType?: string) =>
  buildCapture({
    url,
    requestPostData: "{}",
    responseBody: {},
    requestHeaders: tokenType ? { authorization: `Bearer ${jwt(tokenType)}` } : {},
    timestamp: "2024-09-01T00:00:00Z",
  });
const replay = (url: string, documentUrl: string): ReplayResult =>
  ({
    url,
    authReplay: {
      status: 200,
      tokenReplayable: true,
      tokenSource: { document: 0, url: documentUrl, source: "html" },
    },
  }) as ReplayResult;

describe("bearer sources", () => {
  const captures = [
    call("https://a.test:8443/gql", "client"),
    call("https://z.test/other", "user"),
    call("https://cdn.test:9443/x"),
  ] as never;
  const replays = [
    replay("https://z.test/other", "https://z.test/users"),
    replay("https://a.test:8443/gql", "https://a.test:8443/right"),
  ];

  it("takes the document proven for the token, not the first one located", () => {
    expect(locateBearerSources(captures, replays).size).toBe(2);
    const bearer = deriveReadFlowBearer(captures, replays, "https://a.test:8443/gql");
    expect(bearer?.document).toBe("https://a.test:8443/right");
  });

  it("keeps ports, so hosts compare equal to the runtime's", () => {
    const bearer = deriveReadFlowBearer(captures, replays, "https://a.test:8443/gql");
    expect(bearer?.bearerHosts).toEqual(["a.test:8443", "z.test"]);
    expect(bearer?.otherHosts).toEqual(["cdn.test:9443"]);
  });

  it("is null when no replay proved the endpoint needs the bearer", () => {
    expect(deriveReadFlowBearer(captures, [], "https://a.test:8443/gql")).toBeNull();
  });
});
