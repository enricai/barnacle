import type { createHttpClient } from "@/scraper/http-client";

/**
 * Strips the `as <Type>` assertions `emitMultiStepExecuteHttp` writes so the
 * body can run as plain JS via `new Function`. TypeScript 7's `typescript`
 * package (this repo's devDependency) no longer exposes `transpileModule` —
 * its JS API surface is just `{ version, versionMajorMinor }` — and esbuild
 * is only a transitive dep, not resolvable from this package's own
 * node_modules. Rather than add a new dependency for one test, this strips
 * the exact, closed set of type syntax the emitter is capable of producing
 * inside an executeHttp body: `as Record<string, unknown>` (the httpClient
 * response bindings, recon-generate.ts:2383) and the nested object-literal
 * assertion types `pathToAssertionType` builds for produces[] accessors and
 * fold-plan array accessors (recon-generate.ts:1476-1481, e.g.
 * `as { Auth: { Token: string } }`, and — for a primary array nested inside
 * a grouping array — `as { sections: ({ entries: Record<string, unknown>[] })[] }`).
 * Both are always a parenthesized or bare `as <braces-or-Record>` suffix —
 * never a generic, interface, or decorator — but the object-literal case can
 * itself nest braces arbitrarily deep, so a single non-greedy `[^;]+?\}`
 * regex only matches up to the FIRST inner `}` and truncates the assertion.
 * This walks the string to find the matching close-brace by depth instead.
 */
export function stripEmitterTypeAssertions(body: string): string {
  let stripped = "";
  let cursor = 0;
  while (cursor < body.length) {
    const recordMatch = / as Record<string, unknown>/y;
    recordMatch.lastIndex = cursor;
    if (recordMatch.test(body)) {
      cursor = recordMatch.lastIndex;
      continue;
    }
    if (body.startsWith(" as {", cursor)) {
      const braceStart = cursor + 4;
      let depth = 0;
      let braceEnd = -1;
      for (let i = braceStart; i < body.length; i++) {
        if (body[i] === "{") depth++;
        if (body[i] === "}") {
          depth--;
          if (depth === 0) {
            braceEnd = i;
            break;
          }
        }
      }
      if (braceEnd === -1) {
        throw new Error(
          `stripEmitterTypeAssertions found an unterminated object assertion starting at index ${cursor}`
        );
      }
      // A fold-plan array accessor's assertion is followed by `)[]` — the
      // array-of-groups suffix lives OUTSIDE the brace this loop closed on.
      cursor = body.startsWith("[]", braceEnd + 1) ? braceEnd + 3 : braceEnd + 1;
      continue;
    }
    stripped += body[cursor];
    cursor++;
  }
  if (/\bas\s+[A-Za-z{]/.test(stripped)) {
    throw new Error(
      `stripEmitterTypeAssertions left unstripped TS syntax — emitter output grew a new ` +
        `assertion shape this harness doesn't cover:\n${stripped}`
    );
  }
  return stripped;
}

/**
 * Drives the emitter's OWN executeHttp body against mocked fetch, hermetically.
 *
 * `emitMultiStepExecuteHttp` returns the executeHttp body as a string destined
 * for a generated file that imports `createHttpClient` from
 * `@enricai/barnacle/scraper/http-client` — a subpath that resolves only in a
 * built, out-of-tree consumer, never inside this repo's own test run (see
 * recon-generate.build.test.ts's docblock on the same constraint). Rather than
 * alias that specifier or spawn a real build, this evaluates the body string
 * directly via `new Function`, injecting the exact bindings the generated
 * top-level scope provides (`httpClient`, `payload`) — proving the emitted
 * text also RUNS correctly end to end, wired to the real `createHttpClient`
 * engine module (imported locally via `@/`, not the out-of-tree subpath) with
 * fetch mocked. No network I/O — matches this repo's offline test-suite
 * discipline.
 */
export function evalExecuteHttpBody(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>,
  z: unknown
): (payload: Record<string, unknown>) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    `return async function executeHttp(payload) {\n${stripped}\n};`
  ) as (
    httpClient: unknown,
    z: unknown
  ) => (payload: Record<string, unknown>) => Promise<{ data: unknown }>;
  return factory(httpClient, z);
}

/**
 * Pulls the body of the generated plugin's `async executeHttp(...) { ... }`
 * method out of a full `contract.ts` source string, so a CLI-driven
 * end-to-end test (which only has the emitted file text, not the emitter's
 * internal args) can still eval-and-run it via `evalExecuteHttpBody` instead
 * of merely string-matching the source. Anchored on `executeHttp(` as the
 * start and the plugin object's next method (`async execute(`, the browser
 * fallback recon-generate.ts always emits directly after it) as the end,
 * since both are fixed, emitter-owned markers rather than fixture-specific
 * text.
 */
export function extractExecuteHttpBodyFromContract(contractSource: string): string {
  const signatureMatch = /async executeHttp\([\s\S]*?\): Promise<[^{]*?> \{/.exec(contractSource);
  if (!signatureMatch) {
    throw new Error("extractExecuteHttpBodyFromContract: no executeHttp method found in contract");
  }
  const bodyOpenIndex = signatureMatch.index + signatureMatch[0].length - 1;
  const endMarker = "\n  /** Browser fallback";
  const endIndex = contractSource.indexOf(endMarker, bodyOpenIndex);
  if (endIndex === -1) {
    throw new Error(
      "extractExecuteHttpBodyFromContract: couldn't find the browser-fallback boundary"
    );
  }
  // endIndex points at the doc comment preceding `async execute(`; walk back
  // over the method's closing `},\n\n` to land on just the body text.
  const closingBraceIndex = contractSource.lastIndexOf("},", endIndex);
  return contractSource.slice(bodyOpenIndex + 1, closingBraceIndex);
}
