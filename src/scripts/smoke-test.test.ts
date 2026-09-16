import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getScriptLogger: () => loggerStub,
}));

let loadResponseSchema: typeof import("@/scripts/smoke-test.js").loadResponseSchema;
let parseCli: typeof import("@/scripts/smoke-test.js").parseCli;

beforeAll(async () => {
  ({ loadResponseSchema, parseCli } = await import("@/scripts/smoke-test.js"));
});

describe("smoke-test/parseCli", () => {
  const originalArgv = process.argv;
  const originalSmokeHost = process.env.SMOKE_HOST;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env.SMOKE_HOST = originalSmokeHost;
  });

  it("reads --site/--payload/--host/--route/--fallback/--response-schema/--timeout", () => {
    process.argv = [
      "node",
      "smoke-test.ts",
      "--site",
      "acme",
      "--payload",
      '{"key":"value"}',
      "--host",
      "http://staging:4000",
      "--route",
      "/v1/custom",
      "--fallback",
      "--response-schema",
      "./schema.ts",
      "--timeout",
      "5000",
    ];

    const result = parseCli();

    expect(result.site).toBe("acme");
    expect(result.payload).toEqual({ key: "value" });
    expect(result.host).toBe("http://staging:4000");
    expect(result.route).toBe("/v1/custom");
    expect(result.runFallback).toBe(true);
    expect(result.responseSchemaPath).toMatch(/schema\.ts$/);
    expect(result.timeoutMs).toBe(5000);
  });

  it("defaults host to SMOKE_HOST when set", () => {
    process.env.SMOKE_HOST = "http://from-env:9999";
    process.argv = ["node", "smoke-test.ts", "--site", "acme"];

    const result = parseCli();

    expect(result.host).toBe("http://from-env:9999");
  });

  it("defaults host to http://localhost:3000 when SMOKE_HOST is unset", () => {
    delete process.env.SMOKE_HOST;
    process.argv = ["node", "smoke-test.ts", "--site", "acme"];

    const result = parseCli();

    expect(result.host).toBe("http://localhost:3000");
  });

  it("process.exit(1)s and logs an error when --site is missing", () => {
    process.argv = ["node", "smoke-test.ts"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => parseCli()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerStub.error).toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("process.exit(1)s and logs an error when --payload is invalid JSON", () => {
    process.argv = ["node", "smoke-test.ts", "--site", "acme", "--payload", "{not-json"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    expect(() => parseCli()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerStub.error).toHaveBeenCalledWith(
      expect.stringContaining("invalid --payload JSON")
    );

    exitSpy.mockRestore();
  });
});

describe("smoke-test/loadResponseSchema", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "smoke-test-schema-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a valid Zod-default-export module", async () => {
    const schemaPath = join(tmpDir, "valid-schema.mjs");
    writeFileSync(
      schemaPath,
      `import { z } from "zod/v4";\nexport default z.object({ ok: z.boolean() });\n`
    );

    const schema = await loadResponseSchema(schemaPath);

    expect(schema.safeParse({ ok: true }).success).toBe(true);
  });

  it("process.exit(1)s when the default export is not a Zod schema", async () => {
    const schemaPath = join(tmpDir, "non-zod-schema.mjs");
    writeFileSync(schemaPath, `export default { notASchema: true };\n`);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(loadResponseSchema(schemaPath)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerStub.error).toHaveBeenCalledWith(expect.stringContaining("is not a Zod schema"));

    exitSpy.mockRestore();
  });

  it("process.exit(1)s on an import failure", async () => {
    const schemaPath = join(tmpDir, "does-not-exist.mjs");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(loadResponseSchema(schemaPath)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerStub.error).toHaveBeenCalledWith(expect.stringContaining("failed to import"));

    exitSpy.mockRestore();
  });
});
