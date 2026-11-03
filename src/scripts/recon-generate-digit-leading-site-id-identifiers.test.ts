import { describe, expect, it } from "vitest";
import { emitContractTs, emitIndexTs } from "@/scripts/recon-generate";

function opts(siteId: string, pascal: string) {
  return {
    siteId,
    pascal,
    baseUrl: "https://example.com",
    baseHeaders: {},
    minTime: 100,
    safeRps: 10,
    responseBody: { ok: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/api/example",
    auxFiles: [],
  } as never;
}

const DECL = /\b(?:const|let|var|function|type|interface|class)\s+([^\s=(<:{]+)/g;
const EXPORT_LIST = /export\s*\{([^}]*)\}/g;

function declaredNames(src: string): string[] {
  const names = [...src.matchAll(DECL)].map((m) => m[1] as string);
  for (const m of src.matchAll(EXPORT_LIST)) {
    for (const part of (m[1] as string).split(",")) {
      const n = part.trim().split(/\s+as\s+/);
      for (const x of n) if (x) names.push(x);
    }
  }
  return names;
}

describe("digit-leading siteId yields valid identifiers", () => {
  const siteId = "99example";
  const contract = emitContractTs(opts(siteId, "Site99example"));
  const index = emitIndexTs({ siteId, pascal: "Site99example" });

  it("declares no identifier starting with a digit", () => {
    for (const name of [...declaredNames(contract), ...declaredNames(index)]) {
      expect(name).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
  });

  it("contract const name equals the index export name", () => {
    const m = contract.match(/export const (\w+Plugin)\b/);
    expect(m).not.toBeNull();
    expect(index).toContain(`export { ${m?.[1]}, ${m?.[1]} as plugin }`);
  });

  it("leaves siteId and route strings unchanged", () => {
    expect(contract).toContain(`"${siteId}"`);
    expect(index).toContain(`@/sites/${siteId}/contract`);
    expect(index).toContain(`./dist/sites/${siteId}/index.js`);
  });
});

describe("letter-leading siteId names are unchanged", () => {
  const siteId = "example-shop";
  const contract = emitContractTs(opts(siteId, "ExampleShop"));
  const index = emitIndexTs({ siteId, pascal: "ExampleShop" });

  it("keeps the camelCase plugin name and pascal types", () => {
    expect(contract).toContain("export const exampleShopPlugin");
    expect(index).toContain("export { exampleShopPlugin, exampleShopPlugin as plugin }");
    expect(contract).toContain("ExampleShopPayloadSchema");
  });
});
