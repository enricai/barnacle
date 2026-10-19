import { describe, expect, it } from "vitest";
import {
  unreadPayloadFieldChecklistLines,
  unreferencedDeclaredPayloadFields,
} from "@/scripts/recon-generate";

const DESTINATION = [{ step: "pick the destination", payloadField: "destination" }];
const NIGHTS = [{ step: "pick the nights", payloadField: "nights" }];

describe("unreferencedDeclaredPayloadFields — verdict parity with kind ownership", () => {
  it("treats a plural field spliced into a singular-kind element as threaded", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const contract = "const a = { filters: [`${payload.nights};filterType=night`] };";
    expect(unreferencedDeclaredPayloadFields(contract, "", NIGHTS)).toEqual([]);
  });

  it("treats a singular field spliced into a plural-kind element as threaded", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const contract = "const a = { filters: [`${payload.destination};filterType=destinations`] };";
    expect(unreferencedDeclaredPayloadFields(contract, "", DESTINATION)).toEqual([]);
  });

  it("reports a field whose plural/singular-kind element stays a literal despite a read elsewhere", () => {
    const contract = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "const a = { filters: [`${payload.nights};filterType=night`] };",
      'const b = { filters: ["4;filterType=nights"] };',
    ].join("\n");
    expect(unreferencedDeclaredPayloadFields(contract, "", NIGHTS)).toEqual(["nights"]);
  });

  it("reports a field no request reads even when the element kind differs from the field name", () => {
    const contract = 'const a = { filters: ["ALPHA;filterType=destination"] };';
    const steps = [{ step: "pick the city", payloadField: "city" }];
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual(["city"]);
  });

  it("does not count the schema declaration as a read", () => {
    const contract = "const Schema = z.object({ destination: z.string() });";
    expect(unreferencedDeclaredPayloadFields(contract, "", DESTINATION)).toEqual(["destination"]);
  });

  it("reports only the unthreaded field when two are declared", () => {
    const contract = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      'const a = { filters: [`${payload.destination};filterType=destination`, "4;filterType=night"] };',
    ].join("\n");
    expect(unreferencedDeclaredPayloadFields(contract, "", [...DESTINATION, ...NIGHTS])).toEqual([
      "nights",
    ]);
  });

  it("counts a read that only the browser flow performs as threaded", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const flow = "await act(`pick ${payload.destination}`);";
    expect(unreferencedDeclaredPayloadFields("const a = 1;", flow, DESTINATION)).toEqual([]);
  });

  it("emits one checklist line per unread field and none for threaded fields", () => {
    expect(unreadPayloadFieldChecklistLines(new Set(["nights"]))).toHaveLength(1);
    expect(unreadPayloadFieldChecklistLines(new Set())).toEqual([]);
  });
});
