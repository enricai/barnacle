import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { emitBrowserFlowTs } from "@/scripts/recon-generate";

const flowSteps = [
  { step: "open the cart page", navigateTo: "https://shop.example.com/cart" },
  "click the add button",
  "enter the card number 4242",
  { step: "click Pay", submitStep: true },
];

function emit(mixedHandover?: { tailFromStep: number; handoverUrl?: string }) {
  return emitBrowserFlowTs({
    siteId: "shop",
    pascal: "Shop",
    baseUrl: "https://shop.example.com",
    flowSteps,
    isSubmissionFlow: true,
    mixedHandover,
  });
}

describe("emitBrowserFlowTs mixed handover", () => {
  const withTail = emit({ tailFromStep: 2, handoverUrl: "https://shop.example.com/order/edit" });

  it("hands cookies to the context and navigates with domcontentloaded", () => {
    expect(withTail.code).toContain("sessionCookies: Record<string, string>");
    expect(withTail.code).toContain("stagehand.context.addCookies(");
    expect(withTail.code).toContain('url: new URL("https://shop.example.com/order/edit").origin');
    expect(withTail.code).toContain(
      'page.goto("https://shop.example.com/order/edit", { waitUntil: "domcontentloaded" })'
    );
    expect(withTail.code.indexOf("addCookies")).toBeLessThan(withTail.code.indexOf("page.goto"));
  });

  it("emits step literals only for the tail", () => {
    expect(withTail.code).toContain("enter the card number 4242");
    expect(withTail.code).toContain("click Pay");
    expect(withTail.code).not.toContain("open the cart page");
    expect(withTail.code).not.toContain("click the add button");
  });

  it("defaults the handover URL to the entry url", () => {
    const code = emit({ tailFromStep: 2 }).code;
    expect(code).toContain("new URL(entryUrl).origin");
    expect(code).toContain("page.goto(entryUrl,");
  });

  it("leaves default emission unchanged", () => {
    const code = emit().code;
    expect(code).not.toContain("addCookies");
    expect(code).not.toContain("sessionCookies");
    expect(code).toContain("open the cart page");
  });

  it("emits code that parses as TypeScript, with and without handover", () => {
    for (const code of [withTail.code, emit({ tailFromStep: 2 }).code, emit().code]) {
      const out = ts.transpileModule(code, {
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      expect(out.diagnostics ?? []).toEqual([]);
    }
  });
});
