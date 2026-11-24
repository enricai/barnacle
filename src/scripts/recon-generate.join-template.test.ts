import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECON_FLOW_FILE_SCHEMA } from "@/scripts/recon-browser";
import {
  emitJoinTemplateExpr,
  evalJoinTemplate,
  joinTemplateFields,
  parseFoldReturnSpec,
  parseJoinTemplate,
} from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const flow = (entry: Record<string, unknown>): string =>
  JSON.stringify({ steps: [{ step: "x" }], foldReturn: entry });
const base = { endpointPattern: "/detail", resultsPath: "a.b" };

describe("foldReturn joinTemplate", () => {
  it("composes the drill key per row with a date token", () => {
    const tokens = parseJoinTemplate("{ship}{start|yyMMdd}{pkg}")!;
    expect(
      evalJoinTemplate(tokens, {
        ship: "AB",
        start: "2025-03-07T00:00:00Z",
        pkg: "P1",
      })
    ).toBe("AB250307P1");
    expect(evalJoinTemplate(tokens, { ship: "CD", start: "2026-11-02", pkg: "P2" })).toBe(
      "CD261102P2"
    );
    expect(evalJoinTemplate(tokens, { ship: "CD", pkg: "P2" })).toBeUndefined();
  });

  it("emitted expression agrees with the evaluator", () => {
    const tokens = parseJoinTemplate("{ship}-{start|yyyyMMdd}")!;
    const expr = emitJoinTemplateExpr(tokens, (f) => `item[${JSON.stringify(f)}]`);
    const run = new Function(
      "item",
      `return ${expr.replace(/: (unknown|number \| undefined|string \| number)/g, "").replace(/ as string \| number/g, "")};`
    );
    const item = { ship: "AB", start: "2025-03-07" };
    expect(run(item)).toBe(evalJoinTemplate(tokens, item));
  });

  it("rejects malformed templates", () => {
    expect(parseJoinTemplate("{a")).toBeNull();
    expect(parseJoinTemplate("plain")).toBeNull();
    expect(parseJoinTemplate("{a|bogus}")).toBeNull();
  });

  it("parses joinTemplate and keeps joinFields-only flows unchanged", () => {
    const withT = parseFoldReturnSpec(
      flow({ ...base, joinFields: ["ship"], joinTemplate: "{ship}{d|yyMMdd}" })
    );
    expect(withT?.joinTemplate).toBe("{ship}{d|yyMMdd}");
    const derived = parseFoldReturnSpec(flow({ ...base, joinTemplate: "{ship}{d|yyMMdd}" }));
    expect(derived?.joinFields).toEqual(["ship", "d"]);
    const plain = parseFoldReturnSpec(flow({ ...base, joinFields: ["id"] }));
    expect(plain).toEqual({ ...base, joinFields: ["id"] });
    expect(
      parseFoldReturnSpec(flow({ ...base, joinFields: ["id"], joinTemplate: "{a" }))
    ).toBeNull();
  });

  it("schema accepts joinTemplate and still requires a join key", () => {
    const ok = RECON_FLOW_FILE_SCHEMA.safeParse({
      steps: [{ step: "x", optional: false, upload: false }],
      foldReturn: { ...base, joinTemplate: "{a}{b}" },
    });
    expect(ok.success).toBe(true);
    const bad = RECON_FLOW_FILE_SCHEMA.safeParse({
      steps: [{ step: "x", optional: false, upload: false }],
      foldReturn: base,
    });
    expect(bad.success).toBe(false);
  });

  it("handles dotted paths, numbers, epoch dates and bad inputs", () => {
    const tokens = parseJoinTemplate("{a.id}/{n}/{t|yyyy-MM-dd HH:mm:ss}")!;
    expect(joinTemplateFields(tokens)).toEqual(["a.id", "n", "t"]);
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: 5, t: 0 })).toBe(
      "X/5/1970-01-01 00:00:00"
    );
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: 5, t: "nope" })).toBeUndefined();
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: {}, t: 0 })).toBeUndefined();
    expect(parseJoinTemplate("a}{b}")).toBeNull();
    expect(parseJoinTemplate("{}")).toBeNull();
    expect(parseJoinTemplate("{a|yy|dd}")).toBeNull();
    expect(parseFoldReturnSpec(flow({ ...base, joinTemplate: 5 }))).toBeNull();
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.harbor-ledger-fixture.example.com";
const JWT_LITERAL = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sigfixture";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("read-only multiplexed read flow acceptance (made-up harbor-ledger domain)", () => {
  it("keeps the declared search primary, unfolded join, wired payloadField, no apply skeleton, no JWT literal", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-readonly-accept-"));
    cleanup.push(workDir);
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const query = "query BerthSearch($zone: String!) { berths(zone: $zone) { code day } }";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JWT_LITERAL}`,
    };
    const search = (zone: string, n: number) => ({
      ...buildCapture({
        url: `https://${HOST}/graphql`,
        requestHeaders: headers,
        requestPostData: JSON.stringify({
          operationName: "BerthSearch",
          query,
          variables: { zone },
        }),
        responseBody: {
          data: {
            berths: [
              { code: "AB", day: "2025-03-07" },
              { code: "CD", day: "2025-03-08" },
            ],
          },
        },
        timestamp: `2026-01-01T00:00:0${n}Z`,
      }),
      operationName: "BerthSearch",
      query,
      variables: { zone },
    });
    const files: { name: string; capture: ReturnType<typeof buildCapture> }[] = [
      { name: "000-search.json", capture: search("north", 0) },
      { name: "001-search.json", capture: search("south", 1) },
      {
        name: "002-detail.json",
        capture: buildCapture({
          url: `https://${HOST}/api/detail/AB250307`,
          method: "GET",
          requestHeaders: headers,
          requestPostData: null,
          responseBody: { rows: [{ code: "AB", day: "2025-03-07", price: 5 }] },
          timestamp: "2026-01-01T00:00:02Z",
        }),
      },
    ];
    for (const f of files)
      writeFileSync(join(runRoot, "graphql", f.name), JSON.stringify(f.capture));
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify(files.map((f, index) => ({ index, filename: f.name, url: f.capture.url })))
    );
    const siteId = `readonly-accept-${process.pid}`;
    const siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    cleanup.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "open north zone",
            navigateTo: `https://${HOST}/zones/north`,
            payloadField: "zone",
          },
          {
            step: "open south zone",
            navigateTo: `https://${HOST}/zones/south`,
            payloadField: "zone",
          },
          { step: "search berths" },
        ],
        ownBackendHostnames: [HOST],
        foldReturn: {
          endpointPattern: "api/detail",
          resultsPath: "data.berths",
          drillResultsPath: "rows",
          joinTemplate: "{code}{day|yyMMdd}",
        },
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const out = `${result.stdout}\n${result.stderr}`;
    expect(result.status, out).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(result.stdout, out).toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(contract, out).toContain("BerthSearch");
    // Primary is the declared search; the detail drill folds into it, never the reverse.
    expect(contract.indexOf("/graphql")).toBeLessThan(contract.indexOf("api/detail"));
    expect(contract).toMatch(/foldItems[\s\S]*\.data\.berths/);
    expect(contract).toContain("payload.zone");
    expect(contract).toContain("api/detail");
    expect(contract).toContain("yyMMdd");
    expect(contract).not.toContain(JWT_LITERAL);
    expect(contract).not.toMatch(/ApplicantContact|coverLetter|ClickUrl/i);
    expect(out).not.toContain("is declared by the contract schema but read by no emitted request");
    expect(out).not.toContain("is read by no emitted request");
    expect(out).not.toContain("no fold plan resolved");
  }, 60_000);
});
