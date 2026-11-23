import { describe, expect, it } from "vitest";
import { emitConfigManifest, emitContractTs } from "@/scripts/recon-generate";

const OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

const tagged = [
  'Type "123-45-6789" into the SSN field',
  {
    step: 'Type "Smith" into the Surname field',
    payloadField: "Surname",
    sensitive: "word" as const,
  },
  {
    step: 'Type "5551234567" into the Phone field',
    payloadField: "Phone",
    sensitive: "digits" as const,
  },
];
const plain = ['Type "x" into the Name field', { step: "Click Next", optional: false }];

const manifest = (flowSteps: unknown[]) =>
  JSON.parse(
    emitConfigManifest({ siteId: "t", baseUrl: "https://example.com", flowSteps } as never)
  );

describe("sensitive payload-field tag", () => {
  it("emits meta.redaction naming only tagged fields in the ts plugin", () => {
    const src = emitContractTs({ ...OPTS, flowSteps: tagged } as never);
    expect(src).toContain('redaction: {"digitKeys":["Phone"],"wordKeys":["Surname"]}');
  });
  it("emits spec.redaction in the manifest", () => {
    expect(manifest(tagged).spec.redaction).toEqual({
      digitKeys: ["Phone"],
      wordKeys: ["Surname"],
    });
  });
  it("emits nothing for untagged flows", () => {
    expect(emitContractTs({ ...OPTS, flowSteps: plain } as never)).not.toContain("redaction:");
    expect(manifest(plain).spec).not.toHaveProperty("redaction");
  });
});
