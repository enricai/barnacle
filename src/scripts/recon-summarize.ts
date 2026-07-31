/**
 * Phase 4e: reads captures and replays produced by recon-browser.ts and
 * recon-http.ts and generates docs/target-recon.md — the findings document
 * a teammate needs when the integration breaks.
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-summarize.ts \
 *     [--site-id <id>] [--out docs/target-recon.md] [--run-dir <path>]
 *
 * When --site-id is provided, path placeholders in the output (src/sites/<id>/...)
 * are replaced with the real site ID and the default output path becomes
 * docs/<site-id>-recon.md.
 *
 * --run-dir selects which run root to read; defaults to the most recently
 * modified run root under the recon output base dir (see
 * {@link resolveLatestReconRunRoot}).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { toErrorMessage } from "@/lib/errors";
import { getScriptLogger } from "@/lib/logging";
import {
  type Capture,
  type RateLimitFinding,
  type ReplayResult,
  readJsonDir,
  resolveLatestReconRunRoot,
  tallyResponseHeaders,
} from "@/scripts/recon-shared";

const logger = getScriptLogger("recon-summarize");

const DEFAULT_OUT = "docs/target-recon.md";
const PLACEHOLDER_ID = "<id>";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let siteId = PLACEHOLDER_ID;
  let outPath: string | null = null;
  let runDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site-id" && args[i + 1]) siteId = args[++i]!;
    else if (args[i] === "--out" && args[i + 1]) outPath = args[++i]!;
    else if (args[i] === "--run-dir" && args[i + 1]) runDir = args[++i]!;
  }
  // Default output path is scoped to site ID when one is provided.
  outPath ??= siteId !== PLACEHOLDER_ID ? `docs/${siteId}-recon.md` : DEFAULT_OUT;

  const runRoot = resolveLatestReconRunRoot(runDir);
  logger.info(`reading recon artifacts from ${runRoot}`);
  const capturesDir = join(runRoot, "graphql");
  const replaysDir = join(runRoot, "replays");
  const auxDir = join(runRoot, "aux");

  const captures = readJsonDir<Capture>(capturesDir);
  const replays = readJsonDir<ReplayResult>(replaysDir, [
    "rate-limit.json",
    "introspection-schema.json",
  ]);
  const rateLimitRaw = (() => {
    try {
      return JSON.parse(
        readFileSync(join(replaysDir, "rate-limit.json"), "utf8")
      ) as RateLimitFinding[];
    } catch {
      return [] as RateLimitFinding[];
    }
  })();

  const auxFiles = (() => {
    try {
      return readdirSync(auxDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return [] as string[];
    }
  })();

  const now = new Date().toISOString();
  const reconDate = captures[0]?.timestamp ? formatDate(captures[0].timestamp) : "unknown";

  const uniqueEndpoints = new Map<string, { methods: Set<string>; operations: Set<string> }>();
  for (const c of captures) {
    try {
      const u = new URL(c.url);
      const key = `${u.origin}${u.pathname}`;
      const entry = uniqueEndpoints.get(key) ?? {
        methods: new Set<string>(),
        operations: new Set<string>(),
      };
      entry.methods.add(c.method);
      if (c.operationName) entry.operations.add(c.operationName);
      uniqueEndpoints.set(key, entry);
    } catch {
      // skip
    }
  }

  const replayByUrl = new Map<string, ReplayResult>();
  for (const r of replays) {
    try {
      const u = new URL(r.url);
      replayByUrl.set(`${u.origin}${u.pathname}`, r);
    } catch {
      // skip
    }
  }

  const passed = replays.filter((r) => r.success).length;
  const failed = replays.filter((r) => !r.success).length;

  const has401 = replays.some((r) => r.replayStatus === 401);
  const has403 = replays.some((r) => r.replayStatus === 403);

  const rateLimitSummary =
    rateLimitRaw.length === 0
      ? "Rate-limit probe not yet run."
      : rateLimitRaw
          .map((f) => {
            const safe = f.safeRps !== null ? `${f.safeRps} rps` : "unknown";
            const trigger =
              f.triggerStatus !== null
                ? ` (triggered ${f.triggerStatus} at ${f.triggerRps} rps)`
                : " (no trigger observed)";
            const minTime = f.safeRps !== null ? Math.floor(1000 / f.safeRps) : null;
            const snippet =
              minTime !== null
                ? `\n  \`\`\`typescript\n  // Step 4c: commit this Bottleneck ceiling in your plugin's contract.ts\n  const limiter = new Bottleneck({ minTime: ${minTime} }); // ${f.safeRps} rps safe ceiling\n  \`\`\``
                : "";
            return `- \`${f.endpoint}\`: safe ceiling **${safe}**${trigger}${snippet}`;
          })
          .join("\n");

  const headerCounts = tallyResponseHeaders(replays);
  const successCount = replays.filter((r) => r.success).length;

  const hazards: string[] = [];
  if (has401) hazards.push("Auth required on some endpoints (401)");
  if (has403)
    hazards.push(
      "Bot detection active on some endpoints (403) — may need more headers or Stagehand-only"
    );
  const rateLimitHeaders = rateLimitRaw.flatMap((f) => Object.keys(f.xRateLimitHeaders ?? {}));
  if (rateLimitHeaders.some((h) => h.toLowerCase().includes("akamai")))
    hazards.push("Akamai edge detected");
  if (rateLimitHeaders.some((h) => h.toLowerCase().includes("cf-")))
    hazards.push("Cloudflare edge detected");

  const lines: string[] = [
    `# Target Recon Findings`,
    ``,
    `> Generated by \`recon-summarize.ts\` on ${formatDate(now)} from captures taken ${reconDate}.`,
    `> Human review required — update this doc and \`src/sites/<id>/contract.ts\` then ship.`,
    ``,
    `## Summary`,
    ``,
    `| Stat | Value |`,
    `|------|-------|`,
    `| Captures | ${captures.length} |`,
    `| Unique endpoints | ${uniqueEndpoints.size} |`,
    `| Replay passed | ${passed} |`,
    `| Replay failed | ${failed} |`,
    `| Auth required | ${has401 ? "YES — see §Auth" : "No"} |`,
    `| Bot detection | ${has403 ? "YES — see §Hazards" : "No"} |`,
    `| Auxiliary fixtures | ${auxFiles.length} |`,
    ``,
    `## Endpoints Found`,
    ``,
    ...[...uniqueEndpoints.entries()].map(([endpoint, { methods, operations }]) => {
      const replay = replayByUrl.get(endpoint);
      const replayStatus = replay ? `\`${replay.replayStatus ?? "ERR"}\`` : "not replayed";
      const ops = operations.size > 0 ? `operations: ${[...operations].join(", ")}` : "REST";
      return `- \`${endpoint}\` — ${[...methods].join("/")} — ${ops} — replay: ${replayStatus}`;
    }),
    ``,
    `## Public Endpoints`,
    ``,
    replays.filter((r) => r.success).length === 0
      ? "_None confirmed — all replays failed. Check §Hazards._"
      : replays
          .filter((r) => r.success)
          .map((r) => `- \`${r.url}\` — **public** (replayed ${r.replayStatus})`)
          .join("\n"),
    ``,
    `## Auth Required`,
    ``,
    has401
      ? replays
          .filter((r) => r.replayStatus === 401)
          .map(
            (r) =>
              `- \`${r.url}\` — 401. Capture token, determine lifetime, build refresh strategy.`
          )
          .join("\n")
      : "_No authenticated endpoints detected._",
    ``,
    `## Rate-Limit Ceiling`,
    ``,
    rateLimitSummary,
    ``,
    `## Codified Headers (Step 4b)`,
    ``,
    headerCounts.size === 0
      ? "_No successful replays — run recon-http.ts first._"
      : [
          `_Headers present in successful replays, sorted by frequency. Headers appearing in all_`,
          `_${successCount} successful replay(s) are likely load-bearing. Commit the load-bearing subset_`,
          `_as \`BASE_HEADERS\` in \`src/sites/<id>/contract.ts\` and drop the rest._`,
          ``,
          `| Header | Replays present (of ${successCount}) | Likely load-bearing? |`,
          `|--------|--------------------------------------|----------------------|`,
          ...[...headerCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([header, count]) => {
              const loadBearing = count === successCount ? "**Yes**" : "No";
              return `| \`${header}\` | ${count} | ${loadBearing} |`;
            }),
        ].join("\n"),
    ``,
    `## Hazards`,
    ``,
    hazards.length === 0 ? "_None detected._" : hazards.map((h) => `- ${h}`).join("\n"),
    ``,
    `## Auxiliary Fixtures`,
    ``,
    auxFiles.length === 0
      ? "_No auxiliary fixtures detected. Run Phase 3B (recon-http.ts) to probe static endpoints._"
      : [
          `_Downloaded to \`${auxDir}\` — commit each as a static fixture in \`src/sites/<id>/fixtures/\`._`,
          ``,
          ...auxFiles.map((f) => `- \`${f}\` — commit as \`src/sites/<id>/fixtures/${f}\``),
        ].join("\n"),
    ``,
    `## Codified Query Location`,
    ``,
    `Run \`pnpm run recon:generate -- --site-id <id>\` to generate \`src/sites/<id>/contract.ts\``,
    `from the captured JSON. Review and trim the generated file before registering.`,
    ``,
    `## Maintenance`,
    ``,
    `When smoke test fails: re-run \`pnpm tsx src/scripts/recon-browser.ts\` → diff`,
    `\`${capturesDir}/*<operationName>*.json\` against \`src/sites/<id>/contract.ts\``,
    `→ update query / headers / Zod schema → ship.`,
    ``,
    `---`,
    `_Generated by barnacle recon pipeline. Do not edit by hand — re-run \`recon-summarize.ts\` after each recon run._`,
    ``,
  ];

  mkdirSync(dirname(outPath), { recursive: true });
  const content = lines.join("\n").replaceAll(PLACEHOLDER_ID, siteId);
  writeFileSync(outPath, content);
  logger.info(`findings written to ${outPath}`);
}

main().catch((err) => {
  logger.error(`recon-summarize failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
