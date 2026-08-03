# Bug report: Bedrock-routed models never get Stagehand's structured-output provider options

## Summary

`AISdkClient.createChatCompletion` (in `@browserbasehq/stagehand`) infers
the LLM provider from `modelId` by splitting on `"/"` and taking the first
segment. Bedrock model IDs (e.g. `us.anthropic.claude-opus-5`) contain no
`"/"`, so the inferred "provider name" is the entire ID string, which
matches none of the provider-specific cases in the switch statement that
sets `providerOptions` for structured-output calls. For every
Bedrock-routed model, `providerOptions.anthropic.structuredOutputMode` (and
every other provider's equivalent option) is silently never set. This was
found while live-testing an out-of-tree plugin (`aidfinder-fema`, in the
sibling `af-qa` repo) against a local barnacle server, using
`USE_BEDROCK=true` with `BEDROCK_MODEL=us.anthropic.claude-opus-5`.

## Reproduction

1. Configure a Bedrock-only deployment: `USE_BEDROCK=true`,
   `BEDROCK_MODEL=us.anthropic.claude-opus-5` (or any Bedrock model ID —
   none of them contain `/`).
2. Build and load `af-qa`'s `aidfinder-fema` plugin
   (`BARNACLE_PLUGINS=/path/to/af-qa/dist/fema/aidfinder-fema/index.js`),
   `pnpm dev`.
3. POST a payload that drives the plugin's `execute()` browser path through
   several `stagehand.act()` calls in sequence, e.g.:
   ```sh
   curl -X POST http://localhost:3000/v1/aidfinder-fema/run \
     -H 'Authorization: Bearer anything' \
     -H 'Content-Type: application/json' \
     -d '{"scenario":"ineligibility_notice","baseUrl":"https://stg.aidfinder.com","locationId":"qa-recon"}'
   ```

## Observed vs. expected

**Observed**: intermittent `500 INTERNAL_SERVER_ERROR` —
`"No object generated: response did not match schema."` — reproduced
twice in direct succession on the same scenario/payload. Server log shows
the failure inside Stagehand's own act-handler retry loop (3 outer
attempts, each restarting the whole scraper task, not just the failed
step), with `"no actionable element returned by LLM"` warnings preceding
the final `NoObjectGeneratedError`:
```
[WARN] hot path failed for aidfinder-fema (HttpSchemaError): ... — engaging browser fallback
[INFO] using bedrock model us.anthropic.claude-opus-5 in region us-east-1
[INFO] created browserbase session ...
[INFO] no actionable element returned by LLM
actWithRetry: attempt 1/3 failed for "fill the Social Security Number field with 123-45-6780", retrying
actWithRetry: attempt 2/3 failed for "fill the Social Security Number field with 123-45-6780", retrying
[WARN] scraper attempt 1 failed (UnknownScraperError): No object generated: response did not match schema.; 2 retries left
... (repeats across all 3 outer attempts, each re-navigating and re-logging in) ...
[WARN] scraper attempt 3 failed (UnknownScraperError): No object generated: response did not match schema.; 0 retries left
```

**Expected**: reliable structured-action generation on every `act()` call,
matching the reliability seen with the `openai`/`anthropic`-direct provider
paths, which do get their `providerOptions` set correctly.

## Root cause

`node_modules/@browserbasehq/stagehand/dist/cjs/lib/v3/llm/aisdk.js:10-13`:
```js
function inferProviderName(modelId) {
    const [providerName] = modelId.split("/");
    return providerName || undefined;
}
```
Called at `aisdk.js:119`: `const providerName = inferProviderName(this.model.modelId);`.

The resulting `providerName` feeds a switch statement (`aisdk.js:125-174`)
that sets provider-specific `providerOptions` before calling AI-SDK's
`generateObject` (`aisdk.js:196`) for every `act()`/`extract()` call that
expects a structured response:
```js
switch (providerName) {
    case "openai": providerOptions.openai = { strictJsonSchema: true, ... }; break;
    case "anthropic": providerOptions.anthropic = { structuredOutputMode: "auto", ... }; break;
    case "azure": ...
    case "google": ...
    case "vertex": ...
    case "groq": ...
    case "cerebras": ...
    case "mistral": ...
}
```

This checkout's own `src/lib/bedrock.ts` builds the Bedrock-routed model:
```js
export function createBedrockModel(bedrockConfig) {
  const provider = createAmazonBedrock({ region: bedrockConfig.region, ... });
  return provider(bedrockConfig.model);
}
```
`bedrockConfig.model` is the raw `BEDROCK_MODEL` env var — a Bedrock model
ID like `us.anthropic.claude-opus-5` or a cross-region inference profile
like `us.anthropic.claude-sonnet-4-6[1m]`. Neither format contains a `/`.
Confirmed directly: `"us.anthropic.claude-opus-5".split("/")` returns the
whole string as a single-element array — `inferProviderName` returns that
whole string as `providerName`, which matches none of the switch's cases
(`"openai"`, `"anthropic"`, `"azure"`, `"google"`, `"vertex"`, `"groq"`,
`"cerebras"`, `"mistral"`), so `providerOptions` stays `{}` and
`structuredOutputMode` is never set for any Bedrock-routed model,
regardless of which underlying model family it wraps.

## Confidence / what's not yet proven

- High confidence the code path is exactly as described above — read
  directly, not inferred, and confirmed against this repo's own
  `bedrock.ts` and the real Bedrock model ID this deployment uses.
- Medium confidence that the missing `structuredOutputMode` option is the
  specific cause of the intermittent failure (plausible given the option's
  stated purpose in Stagehand's own code, but not isolated via a controlled
  A/B test — e.g. comparing failure rates with a `/`-containing model ID
  alias vs. without).
- The failure reproduced on one scenario twice; we have not swept every
  Bedrock-routed call site in this deployment to confirm blast radius, and
  `happy_path`'s own browser fallback (same provider/model) has passed
  reliably in adjacent runs — so this looks like an increased failure
  *rate* under Bedrock routing, not a guaranteed break on every call.

## What we're not proposing

Not suggesting a specific fix (e.g. how `inferProviderName` should parse
Bedrock IDs, or where the parsing should live) — that's your call. Flagging
because it's a real, currently-live gap affecting any Bedrock-only
deployment's structured-output reliability, silently degrading rather than
failing loudly (no warning is logged when `providerName` doesn't match any
case — `providerOptions` just stays empty).
