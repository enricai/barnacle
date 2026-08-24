function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges plain-object response bodies for object-spread-style combination,
 * except that arrays found at a colliding key are concatenated rather than
 * overwritten. Plain `Object.assign`/object-spread silently drops one body's
 * items whenever two independently-resolved fold plans share a top-level key
 * that holds an array (e.g. the same paginated primary endpoint drilled into
 * twice, each occurrence resolving a different item) — this preserves both.
 */
export function mergeFoldedPrimaryBodies(
  ...bodies: Record<string, unknown>[]
): Record<string, unknown> {
  return bodies.reduce<Record<string, unknown>>((merged, body) => {
    for (const [key, value] of Object.entries(body)) {
      const existing = merged[key];
      merged[key] =
        Array.isArray(existing) && Array.isArray(value)
          ? [...existing, ...value]
          : isPlainObject(existing) && isPlainObject(value)
            ? mergeFoldedPrimaryBodies(existing, value)
            : value;
    }
    return merged;
  }, {});
}
