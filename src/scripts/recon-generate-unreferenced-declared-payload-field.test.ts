import { describe, expect, it } from "vitest";
import {
  unreadPayloadFieldChecklistLines,
  unreferencedDeclaredPayloadFields,
} from "@/scripts/recon-generate";

describe("unreferencedDeclaredPayloadFields", () => {
  const contract = "Facet: z.string(),\nOther: z.string(),\nconst x = payload.Other;";

  it("returns declared fields no emitted code reads", () => {
    const steps = [{ step: "pick", payloadField: "Facet" }, "plain"];
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual(["Facet"]);
  });

  it("counts a browser-flow reference and ignores prefix matches", () => {
    const steps = [{ step: "pick", payloadField: "Facet" }];
    expect(unreferencedDeclaredPayloadFields(contract, "use(payload.Facet)", steps)).toEqual([]);
    expect(unreferencedDeclaredPayloadFields(contract, "use(payload.FacetMore)", steps)).toEqual([
      "Facet",
    ]);
  });

  it("returns [] when every declared field is referenced", () => {
    const steps = [{ step: "pick", payloadField: "Other" }];
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual([]);
  });
});

describe("unreferencedDeclaredPayloadFields structural matching", () => {
  const contract = "Facet: z.string(),";
  const steps = [{ step: "pick", payloadField: "Facet" }];

  it("ignores payload mentions inside strings and comments", () => {
    expect(
      unreferencedDeclaredPayloadFields(contract, 'log("payload.Facet"); // payload.Facet', steps)
    ).toEqual(["Facet"]);
    expect(unreferencedDeclaredPayloadFields(contract, "/* payload.Facet */", steps)).toEqual([
      "Facet",
    ]);
  });

  it("counts a template-literal splice", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      unreferencedDeclaredPayloadFields(contract, "go(`pick ${payload.Facet}`)", steps)
    ).toEqual([]);
  });
});

describe("unreferencedDeclaredPayloadFields nested braces", () => {
  it("keeps scanning code after a block inside a template expression", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const code = "go(`a ${[1].map((x) => { return x; })} b`); read(payload.Facet);";
    expect(
      unreferencedDeclaredPayloadFields("Facet: z.string(),", code, [
        { step: "pick", payloadField: "Facet" },
      ])
    ).toEqual([]);
  });
});

describe("unreadPayloadFieldChecklistLines", () => {
  it("emits one checklist line per unread field and none for a threaded set", () => {
    const lines = unreadPayloadFieldChecklistLines(new Set(["Facet"]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Facet");
    expect(unreadPayloadFieldChecklistLines(new Set())).toEqual([]);
  });

  it("emits a line for each of several unread fields, naming each", () => {
    const lines = unreadPayloadFieldChecklistLines(new Set(["Facet", "Other"]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Facet");
    expect(lines[1]).toContain("Other");
  });

  it("reports a field whose only mention is incidental text, not a request-body read", () => {
    const steps = [{ step: "pick", payloadField: "Facet" }];
    const unread = unreferencedDeclaredPayloadFields(
      "Facet: z.string(),",
      '// payload.Facet\nconst s = "payload.Facet";',
      steps
    );
    expect(unreadPayloadFieldChecklistLines(new Set(unread))).toHaveLength(1);
    const threaded = unreferencedDeclaredPayloadFields(
      "Facet: z.string(),",
      "send(payload.Facet);",
      steps
    );
    expect(unreadPayloadFieldChecklistLines(new Set(threaded))).toEqual([]);
  });
});
