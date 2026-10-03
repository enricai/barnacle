import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Generalizes the reported defect — several REQUIRED PayloadSchema fields
 * declared but never spliced into any request body, with one of them
 * reachable only from a non-functional tracking header — into a
 * corpus-agnostic structural invariant: every required (non-`.optional()`)
 * field declared on the emitted PayloadSchema must be referenced by a
 * `${payload.<field>}` accessor inside at least one generated request-BODY
 * template, not merely inside a header-object template or nowhere at all.
 * Mirrors the accessors⊆schemaFields direction already covered by
 * recon-generate-1-12-50-payload-field-body-schema-structural-parity-tsc-e2e.test.ts,
 * but drives the converse: schemaFields(required)⊆bodyAccessors.
 *
 * `BaseUrl` is the one documented structural exception: it is a framework
 * field threaded only into the URL template and Origin/Referer headers by
 * design (never a captured request-body field), present on every emitted
 * contract regardless of fixture shape.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.required-schema-field-body-usage-structural-parity-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Each value clears recon-generate's MIN_STATE_VALUE_LENGTH (8), so every
// one is a candidate for splicing as a payload accessor rather than staying
// a frozen literal.
const STORE_ID_VALUE = "STORE-DISTRIBUTION-CENTER-01";
const REGION_VALUE = "REGION-WEST-DISTRIBUTION-01";
const CURRENCY_VALUE = "CURRENCY-USD-STANDARD-01";
const EXPLORE_MORE_PAGE_VALUE = "EXPLORE-MORE-PAGE-TOKEN-01";
// The URL-hash-named category a navigateTo step's explicit payloadField
// annotation binds — re-sent both in a tracking header AND the submit body,
// matching the report's own "5th field referenced only inside a
// non-functional tracking header" shape.
const CATEGORY_FRAGMENT = "widgets-fragment-01";

function fixtureCaptures(): Capture[] {
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({
      page: EXPLORE_MORE_PAGE_VALUE,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
    }),
    requestHeaders: { "Content-Type": "application/json", "X-Catalog-Category": CATEGORY_FRAGMENT },
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // Re-sends every list field verbatim, plus the varying array-valued
  // lineItems field (a structured array/object field, not a scalar) and the
  // navigateTo-facet-bound Category field.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      page: EXPLORE_MORE_PAGE_VALUE,
      storeId: STORE_ID_VALUE,
      region: REGION_VALUE,
      currency: CURRENCY_VALUE,
      Category: CATEGORY_FRAGMENT,
      lineItems: [
        { sku: "WIDGET-1", quantity: 2 },
        { sku: "WIDGET-2", quantity: 1 },
      ],
    }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:01Z",
  });
  return [listPage, submit];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

/** Every `payload.<ident>` accessor referenced anywhere in the given text. */
function extractPayloadAccessors(text: string): Set<string> {
  const accessors = new Set<string>();
  for (const match of text.matchAll(/\bpayload\.([A-Za-z_$][\w$]*)/g)) {
    accessors.add(match[1]!);
  }
  return accessors;
}

/**
 * Every span of text found between a brace-opening token (e.g. `"headers: {"`)
 * and ITS OWN balanced closing brace, tracking nesting depth rather than
 * stopping at the first `}` — the generated `headers: { ... }` object
 * literal's values are template strings that themselves contain `${...}`
 * interpolations, so a naive non-greedy `[^}]*` match truncates at the
 * interpolation's own closing brace instead of the object literal's.
 */
function extractBalancedSpans(text: string, openToken: string): string[] {
  const spans: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(openToken, searchFrom);
    if (idx === -1) break;
    const braceStart = idx + openToken.length - 1;
    let depth = 1;
    let i = braceStart + 1;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    spans.push(text.slice(braceStart + 1, i - 1));
    searchFrom = i;
  }
  return spans;
}

/** Every `payload.<field>` accessor found strictly inside a `body:` backtick template. */
function extractBodyAccessors(contract: string): Set<string> {
  const accessors = new Set<string>();
  for (const match of contract.matchAll(/body:\s*`([^`]*)`,/g)) {
    for (const accessor of extractPayloadAccessors(match[1]!)) accessors.add(accessor);
  }
  return accessors;
}

/** Every `payload.<field>` accessor found inside a `headers: { ... }` object literal. */
function extractHeaderAccessors(contract: string): Set<string> {
  const accessors = new Set<string>();
  for (const span of extractBalancedSpans(contract, "headers: {")) {
    for (const accessor of extractPayloadAccessors(span)) accessors.add(accessor);
  }
  return accessors;
}

/**
 * Every top-level field declared inside the emitted PayloadSchema's
 * `.extend({...})` block(s), paired with whether it is required. Splits
 * entries on top-level commas via bracket-depth tracking (rather than a
 * per-line regex) so a multi-line structured field's definition — e.g. a
 * `multipartJsonObject(z.array(z.object({ sku: ..., quantity: ... })))`
 * value for an array-valued field — isn't misparsed as separate top-level
 * fields named after the nested object's own keys.
 */
function extractSchemaFieldRequiredness(contract: string): Map<string, boolean> {
  const fields = new Map<string, boolean>();
  for (const extendMatch of contract.matchAll(
    /PayloadSchema\s*=[\s\S]*?\.extend\(\{([\s\S]*?)\n\}\)/g
  )) {
    const body = extendMatch[1]!;
    const entries: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of body) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      if (ch === "}" || ch === ")" || ch === "]") depth--;
      if (ch === "," && depth === 0) {
        entries.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim() !== "") entries.push(current);
    for (const entry of entries) {
      const fieldMatch = entry.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
      if (!fieldMatch) continue;
      const required = !fieldMatch[2]!.trim().endsWith(".optional()");
      fields.set(fieldMatch[1]!, required);
    }
  }
  return fields;
}

// A framework field threaded only into the URL template and Origin/Referer
// headers by design — never a captured request-body field — present on
// every emitted contract regardless of fixture shape.
const STRUCTURAL_URL_ONLY_FIELDS = new Set(["BaseUrl"]);

describe("recon-generate CLI — generalized required-schema-field body-usage structural parity", () => {
  it("references every required payload field inside at least one generated request body, not merely a header or nowhere", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-required-schema-field-body-usage-structural-parity-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `required-schema-field-body-usage-structural-parity-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the widgets catalog category page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_FRAGMENT}`,
            payloadField: "Category",
          },
          { step: "browse catalog search" },
          { step: "submit catalog search", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    const schemaFields = extractSchemaFieldRequiredness(contract);
    const requiredFields = [...schemaFields.entries()]
      .filter(([, required]) => required)
      .map(([name]) => name);

    // The corpus is shaped to declare 5+ distinct required fields — a
    // trivial/empty extraction would silently pass with nothing to check.
    expect(requiredFields.length).toBeGreaterThanOrEqual(5);

    const bodyAccessors = extractBodyAccessors(contract);
    const headerAccessors = extractHeaderAccessors(contract);

    // Sanity: the header/body split is actually doing work on this corpus —
    // BaseUrl is genuinely reachable only from a header, never a body, on
    // every emitted contract.
    expect(headerAccessors.has("BaseUrl")).toBe(true);
    expect(bodyAccessors.has("BaseUrl")).toBe(false);

    // Category is the report's own shape: reachable from BOTH a tracking
    // header AND the submit body. Appearing in a header does not exempt a
    // required field from also needing a body occurrence.
    expect(headerAccessors.has("Category")).toBe(true);
    expect(bodyAccessors.has("Category")).toBe(true);

    const requiredWithNoBodyOccurrence = requiredFields.filter(
      (name) => !STRUCTURAL_URL_ONLY_FIELDS.has(name) && !bodyAccessors.has(name)
    );
    expect(
      requiredWithNoBodyOccurrence,
      JSON.stringify({
        requiredFields,
        bodyAccessors: [...bodyAccessors],
        headerAccessors: [...headerAccessors],
      })
    ).toEqual([]);
  }, 30_000);
});
