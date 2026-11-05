import { describe, expect, it } from "vitest";
import { type PayloadSchemaParts, unreadRelaxedResponseUrlFields } from "@/scripts/recon-generate";

const PAYLOAD_EXPR = `z.object({
  homeUrl: z.string().url(),
})`;
const PAYLOAD: PayloadSchemaParts = {
  expr: PAYLOAD_EXPR,
  fields: [{ name: "homeUrl", optional: false }],
};

function contract(extra: string): string {
  return `const payloadSchema = ${PAYLOAD_EXPR};\nconst responseSchema = z.object({\n${extra}\n});`;
}

describe("unreadRelaxedResponseUrlFields", () => {
  it("returns [] when the payload expression is empty", () => {
    expect(unreadRelaxedResponseUrlFields(contract(""), "", { expr: "", fields: [] })).toEqual([]);
  });

  it("returns [] when the contract does not contain the payload expression", () => {
    expect(unreadRelaxedResponseUrlFields("const x = 1;", "", PAYLOAD)).toEqual([]);
  });

  it("reports unread relaxed response *Url leaves outside the payload schema only", () => {
    const code = contract("  bannerUrl: z.string().url().nullable().optional(),");
    expect(unreadRelaxedResponseUrlFields(code, "", PAYLOAD)).toEqual(["bannerUrl"]);
  });

  it("ignores leaves that are read via payload.<name>", () => {
    const code = contract("  bannerUrl: z.string().url().nullable().optional(),");
    expect(unreadRelaxedResponseUrlFields(code, "use(payload.bannerUrl)", PAYLOAD)).toEqual([]);
  });

  it("ignores non-relaxed response leaves", () => {
    const code = contract("  bannerUrl: z.string().url(),");
    expect(unreadRelaxedResponseUrlFields(code, "", PAYLOAD)).toEqual([]);
  });
});
