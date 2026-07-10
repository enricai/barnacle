/**
 * Converts a JSON-Schema fragment into a live Zod schema instance built from
 * the project's own `zod/v4` import. Config plugins declare their request,
 * response, and extract shapes as inert JSON Schema in the manifest; the loader
 * needs real Zod instances because `validatePluginShape`
 * (`src/plugins/discover.ts`) duck-types `meta.bodySchema`/`meta.responseSchema`
 * for `safeParse`/`parse`, and `guardedExtract` constrains its schema argument
 * to `z.ZodTypeAny`.
 *
 * Why in-house and not a library: `z.fromJSONSchema` does not exist on the
 * pinned `zod@3.25.76` (only the reverse `z.toJSONSchema`), and any third-party
 * converter would emit an instance from a *different* Zod copy — failing both
 * the loader duck-type and Stagehand's `StagehandZodSchema` union. Building from
 * this module's own `z` is the only instance-safe route.
 *
 * Scope is deliberately the flat form real form-field payloads need
 * (object/string/number/integer/boolean/array/enum + `required`). Anything
 * outside that surface throws at load time rather than silently degrading, so a
 * manifest that leans on unsupported JSON-Schema features fails loudly.
 */

import { z } from "zod/v4";

/** Thrown when a manifest schema uses a JSON-Schema construct this converter does not support. */
export class UnsupportedJsonSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedJsonSchemaError";
  }
}

/**
 * Recursive shape of the JSON-Schema subset this converter accepts. Validated
 * structurally by {@link JSON_SCHEMA_NODE} before conversion so a malformed
 * manifest schema is rejected with a Zod error rather than a runtime crash
 * mid-conversion.
 */
export interface JsonSchemaNode {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: string[];
  format?: string;
  description?: string;
}

const JSON_SCHEMA_NODE: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "string", "number", "integer", "boolean", "array"]).optional(),
      properties: z.record(z.string(), JSON_SCHEMA_NODE).optional(),
      required: z.array(z.string()).optional(),
      items: JSON_SCHEMA_NODE.optional(),
      enum: z.array(z.string()).min(1).optional(),
      format: z.string().optional(),
      description: z.string().optional(),
    })
    .strict()
);

/** Builds the Zod leaf/branch for one already-validated JSON-Schema node. */
function nodeToZod(node: JsonSchemaNode): z.ZodTypeAny {
  if (node.enum) {
    return z.enum(node.enum as [string, ...string[]]);
  }

  switch (node.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(node.items ? nodeToZod(node.items) : z.unknown());
    case "object": {
      const required = new Set(node.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const childSchema = nodeToZod(child);
        shape[key] = required.has(key) ? childSchema : childSchema.optional();
      }
      return z.object(shape);
    }
    default:
      throw new UnsupportedJsonSchemaError(
        `unsupported JSON-Schema node: ${JSON.stringify(node).slice(0, 120)}`
      );
  }
}

/**
 * Converts a manifest's JSON-Schema fragment into a Zod schema instance.
 * Validates the fragment's structure first so unsupported constructs surface as
 * a descriptive error at plugin-load time instead of a downstream parse crash.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  const parsed = JSON_SCHEMA_NODE.safeParse(schema);
  if (!parsed.success) {
    throw new UnsupportedJsonSchemaError(
      `invalid or unsupported JSON schema: ${parsed.error.message}`
    );
  }
  return nodeToZod(parsed.data);
}
