"use strict";
/**
 * Nightly validation: runs one request through a plugin's endpoint end-to-end
 * and validates the response envelope shape and HTTP status. Exits 0 on
 * success, non-zero on HTTP error or malformed envelope. Wire into CI and
 * cron — this is the first rung of the drift-detection ladder.
 *
 * Usage:
 *   pnpm run smoke -- --site <siteId> --payload '{"key":"value"}' \
 *     [--host http://localhost:3000] [--route <path>] [--fallback] \
 *     [--response-schema <path>] [--timeout <ms>]
 *
 * --response-schema must point to a TypeScript/JS module whose default export is a
 * Zod schema. The smoke test validates the full response body against it — not just
 * the envelope wrapper — so schema drift on the data payload fails loud and fast.
 *
 * Requires:
 *   - The server to be running (or pass --host to point at staging/prod)
 *   - API_KEY env var with a plaintext key that matches one of API_KEYS_HASHED
 *   - The target plugin to be registered and healthy
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = require("node:path");
const v4_1 = require("zod/v4");
const errors_1 = require("../lib/errors");
const http_1 = require("../lib/http");
const logging_1 = require("../lib/logging");
(0, http_1.configureHttpDispatcher)();
const logger = (0, logging_1.getScriptLogger)("smoke-test");
const DEFAULT_HOST = "http://localhost:3000";
const ResponseEnvelopeSchema = v4_1.z.object({
    status: v4_1.z.object({
        httpStatus: v4_1.z.string(),
        dateTime: v4_1.z.string(),
        details: v4_1.z.array(v4_1.z.unknown()),
    }),
});
const DEFAULT_TIMEOUT_MS = 30_000;
function parseCli() {
    const args = process.argv.slice(2);
    let site = "";
    let payloadStr = "{}";
    let host = process.env.SMOKE_HOST ?? DEFAULT_HOST;
    let route = null;
    let runFallback = false;
    let responseSchemaPath = null;
    let timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--site" && args[i + 1])
            site = args[++i];
        else if (args[i] === "--payload" && args[i + 1])
            payloadStr = args[++i];
        else if (args[i] === "--host" && args[i + 1])
            host = args[++i];
        else if (args[i] === "--route" && args[i + 1])
            route = args[++i];
        else if (args[i] === "--fallback")
            runFallback = true;
        else if (args[i] === "--response-schema" && args[i + 1])
            responseSchemaPath = (0, node_path_1.resolve)(args[++i]);
        else if (args[i] === "--timeout" && args[i + 1])
            timeoutMs = Number(args[++i]);
    }
    if (!site) {
        logger.error("usage: smoke-test.ts --site <siteId> [--payload <json>] [--host <url>] [--route <path>] [--fallback] [--response-schema <path>] [--timeout <ms>]");
        process.exit(1);
    }
    let payload;
    try {
        payload = JSON.parse(payloadStr);
    }
    catch {
        logger.error(`invalid --payload JSON: ${payloadStr}`);
        process.exit(1);
    }
    return { site, payload, host, route, runFallback, responseSchemaPath, timeoutMs };
}
/**
 * Dynamically imports a Zod schema from a module path. The module must
 * export a Zod schema as its default export so the smoke test remains
 * site-agnostic — it validates without knowing which plugin it targets.
 */
async function loadResponseSchema(schemaPath) {
    try {
        const mod = (await import(schemaPath));
        if (!mod.default || typeof mod.default.safeParse !== "function") {
            logger.error(`--response-schema: default export from ${schemaPath} is not a Zod schema`);
            process.exit(1);
        }
        return mod.default;
    }
    catch (err) {
        logger.error(`--response-schema: failed to import ${schemaPath}: ${(0, errors_1.toErrorMessage)(err)}`);
        process.exit(1);
    }
}
async function main() {
    const { site, payload, host, route, runFallback, responseSchemaPath, timeoutMs } = parseCli();
    const responseSchema = responseSchemaPath ? await loadResponseSchema(responseSchemaPath) : null;
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        logger.error("API_KEY env var required");
        process.exit(1);
    }
    const url = route != null ? `${host}${route}` : `${host}/v1/${site}/run`;
    logger.info(`smoke-test: POST ${url}${route != null ? " (routeOverride)" : ""} (timeout=${timeoutMs}ms)`);
    logger.info(`payload: ${JSON.stringify(payload)}`);
    const startMs = Date.now();
    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            logger.error(`smoke-test timed out after ${timeoutMs}ms`);
        }
        else {
            logger.error(`fetch failed: ${(0, errors_1.toErrorMessage)(err)}`);
        }
        process.exit(1);
    }
    finally {
        clearTimeout(timer);
    }
    const latencyMs = Date.now() - startMs;
    logger.info(`response: ${response.status} in ${latencyMs}ms`);
    let body;
    try {
        body = await response.json();
    }
    catch (err) {
        logger.error(`response body is not JSON: ${(0, errors_1.toErrorMessage)(err)}`);
        process.exit(1);
    }
    const envelope = ResponseEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
        logger.error(`response does not match envelope schema: ${JSON.stringify(envelope.error.issues, null, 2)}`);
        process.exit(1);
    }
    if (!response.ok) {
        logger.error(`smoke-test FAILED — HTTP ${response.status}: ${JSON.stringify(body, null, 2)}`);
        process.exit(1);
    }
    if (envelope.data.status.httpStatus !== "OK") {
        logger.error(`smoke-test FAILED — envelope status: ${envelope.data.status.httpStatus}: ${JSON.stringify(body, null, 2)}`);
        process.exit(1);
    }
    if (responseSchema) {
        const dataResult = responseSchema.safeParse(body);
        if (!dataResult.success) {
            logger.error(`smoke-test FAILED — response body failed schema validation: ${JSON.stringify(dataResult.error.issues, null, 2)}`);
            process.exit(1);
        }
        logger.info("schema validation PASSED");
    }
    logger.info(`smoke-test PASSED — site=${site} status=OK latency=${latencyMs}ms`);
    if (runFallback) {
        logger.info("smoke-test: running optional fallback-path probe...");
        const fallbackStartMs = Date.now();
        let fallbackResponse;
        const fallbackController = new AbortController();
        const fallbackTimer = setTimeout(() => fallbackController.abort(), timeoutMs);
        try {
            fallbackResponse = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                    "X-Barnacle-Force-Fallback": "true",
                },
                body: JSON.stringify(payload),
                signal: fallbackController.signal,
            });
        }
        catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                logger.error(`smoke-test (fallback) timed out after ${timeoutMs}ms`);
            }
            else {
                logger.error(`fallback probe fetch failed: ${(0, errors_1.toErrorMessage)(err)}`);
            }
            process.exit(1);
        }
        finally {
            clearTimeout(fallbackTimer);
        }
        const fallbackLatencyMs = Date.now() - fallbackStartMs;
        logger.info(`fallback response: ${fallbackResponse.status} in ${fallbackLatencyMs}ms`);
        if (!fallbackResponse.ok) {
            const body = await fallbackResponse.text().catch(() => "(unreadable body)");
            logger.error(`smoke-test FAILED (fallback) — HTTP ${fallbackResponse.status}: ${body}`);
            process.exit(1);
        }
        let fallbackBody;
        try {
            fallbackBody = await fallbackResponse.json();
        }
        catch (err) {
            logger.error(`fallback response body is not JSON: ${(0, errors_1.toErrorMessage)(err)}`);
            process.exit(1);
        }
        const fallbackEnvelope = ResponseEnvelopeSchema.safeParse(fallbackBody);
        if (!fallbackEnvelope.success) {
            logger.error(`fallback response does not match envelope schema: ${JSON.stringify(fallbackEnvelope.error.issues, null, 2)}`);
            process.exit(1);
        }
        if (fallbackEnvelope.data.status.httpStatus !== "OK") {
            logger.error(`smoke-test FAILED (fallback) — envelope status: ${fallbackEnvelope.data.status.httpStatus}: ${JSON.stringify(fallbackBody, null, 2)}`);
            process.exit(1);
        }
        if (responseSchema) {
            const fallbackDataResult = responseSchema.safeParse(fallbackBody);
            if (!fallbackDataResult.success) {
                logger.error(`smoke-test FAILED (fallback) — response body failed schema validation: ${JSON.stringify(fallbackDataResult.error.issues, null, 2)}`);
                process.exit(1);
            }
            logger.info("schema validation PASSED (fallback)");
        }
        logger.info(`smoke-test PASSED (fallback) — site=${site} status=OK latency=${fallbackLatencyMs}ms`);
    }
}
main().catch((err) => {
    logger.error(`smoke-test error: ${(0, errors_1.toErrorMessage)(err)}`);
    process.exit(1);
});
//# sourceMappingURL=smoke-test.js.map