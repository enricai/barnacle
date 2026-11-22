import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContractChecklist,
  compileActionSteps,
  detectContractGaps,
  emitMultiStepExecuteHttp,
  extractActionSequence,
  findFrozenRequestTokens,
  harvestRunPersonaBindings,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const WIZARD = "https://jobs.example.com";
const SIBLING = "https://forms.example.com";
const JOB_ID = "4815162";
const SLUG = "senior-widget-engineer";
const CSRF = "A1B2C3D4E5F60718";
const HASHED = "-918273645";
const EMAIL = "persona.recon@example.com";
const CAPTCHA_FIELDS = ["h-captcha-response", "g-recaptcha-response", "cf-turnstile-response"];
const TOKENS = CAPTCHA_FIELDS.map((_, i) => `P1_solvedCaptchaToken${i}_Zk9qXv81T3mWb7LpR2dYc5Hn`);
const BOUNDARY = "----WebKitFormBoundaryQT3ET94GAL8ub8NP";

const part = (name: string, value: string): string =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const multipart = (parts: Array<[string, string]>): string =>
  `${parts.map(([n, v]) => part(n, v)).join("")}--${BOUNDARY}--\r\n`;
const MP = `multipart/form-data; boundary=${BOUNDARY}`;
const UE = "application/x-www-form-urlencoded";
const ts = (n: number): string => `2024-01-01T00:00:0${n}Z`;

function wizard(withCaptcha: boolean) {
  const cap = (field: number): Array<[string, string]> =>
    withCaptcha ? [[CAPTCHA_FIELDS[field]!, TOKENS[field]!]] : [];
  const base = `${WIZARD}/jobs/${JOB_ID}/${SLUG}`;
  const post = (
    n: number,
    url: string,
    ct: string,
    body: string,
    status = 200,
    responseBody: unknown = { ok: true }
  ) => ({
    ...buildCapture({
      url,
      requestPostData: body,
      requestHeaders: { "Content-Type": ct },
      responseBody,
      timestamp: ts(n),
    }),
    status,
  });
  return [
    buildCapture({
      url: `${base}/login`,
      method: "GET",
      requestPostData: null,
      responseHeaders: { "content-type": "text/html" },
      responseBody: `<html><form action="${base}/candidate?from=login&amp;csrf=${CSRF}&amp;in_iframe=1&amp;hashed=${HASHED}"></form></html>`,
      timestamp: ts(0),
    }),
    post(
      1,
      `${base}/candidate?from=login&csrf=${CSRF}&in_iframe=1&hashed=${HASHED}`,
      MP,
      multipart([["css_loginName", EMAIL], ...cap(0), ...cap(1)]),
      302,
      ""
    ),
    post(
      2,
      `${base}/eeo?csrf=${CSRF}`,
      MP,
      multipart([["css_loginName", EMAIL], ...cap(2)]),
      302,
      ""
    ),
    post(
      3,
      `${SIBLING}/servlet/showForm?step=disability`,
      UE,
      `name=${HASHED}&email=${encodeURIComponent(EMAIL)}`,
      302,
      ""
    ),
    post(4, `${SIBLING}/servlet/showForm?step=ack`, UE, "ack=yes&done=1"),
  ];
}

function run(captures: ReturnType<typeof wizard>, personaBindings: Map<string, string>) {
  const seq = extractActionSequence(captures);
  const idx = new Set(seq.map((a) => a.index));
  const state = indexStateValues(captures, new Set(), idx);
  const steps = compileActionSteps(seq, state);
  const discovered = new Set<string>();
  const body = emitMultiStepExecuteHttp(
    steps,
    null,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    discovered,
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    WIZARD,
    new Map(),
    new Map(),
    null,
    personaBindings,
    new Map([
      [JOB_ID, 'new URL(payload.ClickUrl).pathname.split("/")[2]'],
      [SLUG, 'new URL(payload.ClickUrl).pathname.split("/")[3]'],
    ])
  );
  return { seq, steps, body, discovered };
}

const vocab = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bemail\b/i, "Email"]],
} as never;

describe("captcha-gated multi-host server-rendered wizard", () => {
  const root = mkdtempSync(join(tmpdir(), "wizard-"));
  writeFileSync(join(root, "persona-env.json"), JSON.stringify({ RECON_EMAIL: EMAIL }));
  const persona = harvestRunPersonaBindings(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded from env by the code under test
    ["Fill in the Email field with '${RECON_EMAIL}'"] as never,
    vocab,
    root,
    {}
  );

  it("binds the persona email from the run dir with no RECON_* env", () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith("RECON_"))).toEqual([]);
    expect(persona.get(EMAIL)).toBe("payload.Email");
  });

  it("flags every captcha-gated step so no solved token reaches the emitted contract", () => {
    const caps = wizard(true);
    const { seq, steps, body } = run(caps, persona);
    const frozen = findFrozenRequestTokens(steps, caps, body);
    for (const t of TOKENS) expect(frozen).toContain(t);
    const gaps = detectContractGaps(steps, true, () => true, body);
    expect(seq.length).toBeGreaterThan(0);
    expect(gaps.captchaGatedSteps).toBe(2);
    expect(buildContractChecklist({ pascal: "X", gql: false, gqlQuery: null, gaps })).toEqual(
      expect.arrayContaining([expect.stringMatching(/captcha-gated/)])
    );
  });

  describe("emitted hot path", () => {
    const caps = wizard(false);
    const { seq, body, discovered } = run(caps, persona);

    it("keeps sibling-host submits through the final step", () => {
      expect(seq.map((a) => a.index)).toEqual(expect.arrayContaining([3, 4]));
      expect(body).toContain("/servlet/showForm?step=disability");
      expect(body).toContain("/servlet/showForm?step=ack");
    });

    it("threads csrf/hash from the prior form action and freezes no job id", () => {
      expect(body).not.toContain(CSRF);
      expect(body).not.toContain(HASHED.replace("-", ""));
      expect(body).not.toContain(JOB_ID);
      expect(body).not.toContain(SLUG);
      expect(body).toContain("payload.ClickUrl");
    });

    it("sends multipart calls with a multipart Content-Type and binds the persona", () => {
      expect(body).toContain(`"Content-Type": \`${MP}\``);
      expect(body).not.toContain(EMAIL);
      expect(body).toContain("payload.Email");
      expect(discovered.has("Email")).toBe(true);
    });
  });
});
